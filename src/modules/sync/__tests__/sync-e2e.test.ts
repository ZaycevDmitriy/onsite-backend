import { randomUUID } from 'node:crypto';

import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { hash } from '@node-rs/argon2';
import { asc, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeTestConfig } from '@/__tests__/helpers/test-config.js';
import { buildApp } from '@/app.js';
import { refreshSessions } from '@/modules/auth/db-schema.js';
import { pushOutbox } from '@/modules/notifications/db-schema.js';
import { orderAssignments, orderEvents, orders } from '@/modules/orders/db-schema.js';
import { photos } from '@/modules/photos/db-schema.js';
import { syncMutations } from '@/modules/sync/db-schema.js';
import { users } from '@/modules/users/db-schema.js';

import type { IAppConfig } from '@/shared/config/index.js';
import type { UserRoleEnum } from '@/modules/users/index.js';
import type { FastifyInstance } from 'fastify';

// e2e «офлайн-смена» техника (T-14, NFR-04): 3 обрыва сети (повторные отправки батча), требует БД и S3.
const databaseUrl = process.env.DATABASE_URL;
const s3Endpoint = process.env.S3_ENDPOINT;

const PASSWORD = 'sync-e2e-test-secret-1';
const EMAIL_PREFIX = 'sync-e2e-test-';
const MULTIPART_BOUNDARY = '----syncE2eTestBoundary5591207';
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// 3 «обрыва сети» после первой отправки — клиент не знает исход и повторяет тот же батч.
const NETWORK_DROP_RETRIES = 3;

interface IOrderView {
  id: string;
  status: string;
  updatedSeq: number;
}

interface IPhotoView {
  id: string;
  status: string;
}

interface ISyncMutationVerdict {
  mutationId: string;
  result: 'applied' | 'duplicate' | 'conflict' | 'rejected';
  order?: IOrderView;
}

interface ISyncPullOrderItem {
  type: 'order';
  seq: number;
  order: IOrderView & { photos: { id: string; status: string }[] };
}

const isBucketAlreadyExistsError = (error: unknown): boolean => {
  const name = (error as { name?: string }).name;

  return name === 'BucketAlreadyOwnedByYou' || name === 'BucketAlreadyExists';
};

const ensureBucketExists = async (config: IAppConfig): Promise<void> => {
  const client = new S3Client({
    endpoint: config.s3Endpoint,
    region: config.s3Region,
    credentials: { accessKeyId: config.s3AccessKey, secretAccessKey: config.s3SecretKey },
    forcePathStyle: true,
  });

  try {
    await client.send(new CreateBucketCommand({ Bucket: config.s3Bucket }));
  } catch (error) {
    if (!isBucketAlreadyExistsError(error)) {
      throw error;
    }
  } finally {
    client.destroy();
  }
};

describe.runIf(databaseUrl && s3Endpoint)('sync e2e: офлайн-смена техника (T-14)', () => {
  let app: FastifyInstance;
  let dispatcherToken: string;
  const createdUserIds: string[] = [];
  const createdOrderIds: string[] = [];
  const createdMutationIds: string[] = [];

  const seedUser = async (role: UserRoleEnum): Promise<{ id: string; email: string }> => {
    const id = randomUUID();
    const email = `${EMAIL_PREFIX}${id}@onsite.test`;
    await app.db.insert(users).values({
      id,
      email,
      passwordHash: await hash(PASSWORD),
      role,
      displayName: 'Тестовый Участник',
    });
    createdUserIds.push(id);

    return { id, email };
  };

  const loginAs = async (email: string): Promise<string> => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password: PASSWORD },
    });
    expect(response.statusCode).toBe(200);

    return response.json<{ accessToken: string }>().accessToken;
  };

  const authHeaders = (token: string): Record<string, string> => ({
    authorization: `Bearer ${token}`,
  });

  const createOrder = async (title: string): Promise<IOrderView> => {
    const now = Date.now();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: authHeaders(dispatcherToken),
      payload: {
        title,
        client: 'Тестовый Клиент',
        address: 'ул. Тестовая, 1',
        description: 'Описание заявки для e2e офлайн-смены.',
        scheduledAt: new Date(now).toISOString(),
        slotStart: new Date(now).toISOString(),
        slotEnd: new Date(now + 60 * 60 * 1000).toISOString(),
      },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json<IOrderView>();
    createdOrderIds.push(body.id);

    return body;
  };

  const assignTechnician = async (orderId: string, technicianId: string): Promise<void> => {
    const response = await app.inject({
      method: 'POST',
      url: `/v1/orders/${orderId}/assign`,
      headers: authHeaders(dispatcherToken),
      payload: { technicianId },
    });
    expect(response.statusCode).toBe(200);
  };

  const uploadStagedPhoto = async (token: string, orderId: string): Promise<IPhotoView> => {
    const idempotencyKey = randomUUID();
    const fileBuffer = Buffer.concat([PNG_MAGIC, Buffer.from('sync-e2e-photo', 'utf8')]);
    const body = Buffer.concat([
      Buffer.from(
        `--${MULTIPART_BOUNDARY}\r\n` +
          `Content-Disposition: form-data; name="file"; filename="test.png"\r\n` +
          `Content-Type: image/png\r\n\r\n`,
      ),
      fileBuffer,
      Buffer.from('\r\n'),
      Buffer.from(
        `--${MULTIPART_BOUNDARY}\r\n` +
          `Content-Disposition: form-data; name="takenAt"\r\n\r\n` +
          `${new Date().toISOString()}\r\n`,
      ),
      Buffer.from(`--${MULTIPART_BOUNDARY}--\r\n`),
    ]);

    const response = await app.inject({
      method: 'POST',
      url: `/v1/orders/${orderId}/photos`,
      headers: {
        ...authHeaders(token),
        'content-type': `multipart/form-data; boundary=${MULTIPART_BOUNDARY}`,
        'idempotency-key': idempotencyKey,
      },
      payload: body,
    });
    expect(response.statusCode).toBe(201);

    return response.json<IPhotoView>();
  };

  const submitMutations = async (
    token: string,
    mutations: Record<string, unknown>[],
  ): Promise<ISyncMutationVerdict[]> => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/sync/mutations',
      headers: authHeaders(token),
      payload: { mutations },
    });
    expect(response.statusCode).toBe(200);

    return response.json<{ verdicts: ISyncMutationVerdict[] }>().verdicts;
  };

  const pull = async (
    token: string,
    query = '',
  ): Promise<{ items: ISyncPullOrderItem[]; nextCursor: number }> => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/sync/orders${query}`,
      headers: authHeaders(token),
    });
    expect(response.statusCode).toBe(200);

    return response.json<{ items: ISyncPullOrderItem[]; nextCursor: number }>();
  };

  beforeAll(async () => {
    const config = makeTestConfig(databaseUrl as string, { syncSafetyLag: 0 });
    await ensureBucketExists(config);

    app = await buildApp(config);
    await app.ready();

    const dispatcher = await seedUser('dispatcher');
    dispatcherToken = await loginAs(dispatcher.email);
  });

  afterAll(async () => {
    if (createdMutationIds.length > 0) {
      await app.db
        .delete(syncMutations)
        .where(inArray(syncMutations.mutationId, createdMutationIds));
    }
    if (createdOrderIds.length > 0) {
      await app.db.delete(photos).where(inArray(photos.orderId, createdOrderIds));
      await app.db.delete(orderEvents).where(inArray(orderEvents.orderId, createdOrderIds));
      await app.db
        .delete(orderAssignments)
        .where(inArray(orderAssignments.orderId, createdOrderIds));
      await app.db.delete(orders).where(inArray(orders.id, createdOrderIds));
    }
    if (createdUserIds.length > 0) {
      await app.db.delete(refreshSessions).where(inArray(refreshSessions.userId, createdUserIds));
      await app.db.delete(pushOutbox).where(inArray(pushOutbox.userId, createdUserIds));
      await app.db.delete(users).where(inArray(users.id, createdUserIds));
    }
    await app.close();
  });

  it('офлайн-смена: batch из 4 мутаций пережил 3 обрыва сети без потерь и дублей', async () => {
    const technician = await seedUser('technician');
    const technicianToken = await loginAs(technician.email);

    // Диспетчер готовит смену: две заявки, обе назначены технику, техник уходит в офлайн.
    const order1 = await createOrder('Смена: заявка 1');
    const order2 = await createOrder('Смена: заявка 2');
    await assignTechnician(order1.id, technician.id);
    await assignTechnician(order2.id, technician.id);

    // Фото было выгружено, пока связь ненадолго появлялась — коммит идёт мутацией уже офлайн.
    const photo = await uploadStagedPhoto(technicianToken, order1.id);

    const startInProgress1 = randomUUID();
    const addPhoto1 = randomUUID();
    const finishOrder1 = randomUUID();
    const startInProgress2 = randomUUID();
    createdMutationIds.push(startInProgress1, addPhoto1, finishOrder1, startInProgress2);

    // Локальная очередь мутаций техника за смену, накопленная офлайн, единым батчем.
    const offlineBatch = [
      {
        mutationId: startInProgress1,
        type: 'status_change',
        orderId: order1.id,
        to: 'InProgress',
        baseStatus: 'New',
      },
      { mutationId: addPhoto1, type: 'photo_add', orderId: order1.id, photoId: photo.id },
      {
        mutationId: finishOrder1,
        type: 'status_change',
        orderId: order1.id,
        to: 'Done',
        baseStatus: 'InProgress',
      },
      {
        mutationId: startInProgress2,
        type: 'status_change',
        orderId: order2.id,
        to: 'InProgress',
        baseStatus: 'New',
      },
    ];

    // Первая отправка — реально применяется. Далее 3 повтора после симулированных обрывов сети:
    // клиент не увидел ответ и повторяет тот же батч байт-в-байт.
    const submissions: ISyncMutationVerdict[][] = [];
    for (let attempt = 0; attempt <= NETWORK_DROP_RETRIES; attempt += 1) {
      submissions.push(await submitMutations(technicianToken, offlineBatch));
    }

    const [firstSubmission, ...retries] = submissions;
    expect(firstSubmission).toBeDefined();
    for (const mutation of offlineBatch) {
      const original = firstSubmission?.find((v) => v.mutationId === mutation['mutationId']);
      expect(original?.result).toBe('applied');
    }

    // 0 задублированных мутаций: каждый повтор возвращает duplicate байт-в-байт с исходным вердиктом.
    for (const retry of retries) {
      for (const mutation of offlineBatch) {
        const original = firstSubmission?.find((v) => v.mutationId === mutation['mutationId']);
        const repeated = retry.find((v) => v.mutationId === mutation['mutationId']);
        expect(repeated?.result).toBe('duplicate');
        expect(repeated?.order).toEqual(original?.order);
      }
    }

    // 0 потерянных мутаций: ровно одна запись sync_mutations на mutationId, все — applied в исходном вердикте.
    const mutationRows = await app.db
      .select()
      .from(syncMutations)
      .where(
        inArray(syncMutations.mutationId, [
          startInProgress1,
          addPhoto1,
          finishOrder1,
          startInProgress2,
        ]),
      );
    expect(mutationRows).toHaveLength(4);
    expect(mutationRows.every((row) => row.result === 'applied')).toBe(true);

    // Полная хронология order1: created, assigned, status_changed×2 (sync), photo_added (sync) —
    // строго в порядке применения мутаций батча, без дублей от 3 повторов.
    const order1Events = await app.db
      .select()
      .from(orderEvents)
      .where(eq(orderEvents.orderId, order1.id))
      .orderBy(asc(orderEvents.id));
    expect(order1Events.map((event) => event.type)).toEqual([
      'created',
      'assigned',
      'status_changed',
      'photo_added',
      'status_changed',
    ]);
    expect(order1Events.filter((event) => event.source === 'sync')).toHaveLength(3);

    const order2Events = await app.db
      .select()
      .from(orderEvents)
      .where(eq(orderEvents.orderId, order2.id))
      .orderBy(asc(orderEvents.id));
    expect(order2Events.map((event) => event.type)).toEqual(['created', 'assigned', 'status_changed']);

    // Итоговое состояние подтверждается pull: заявка 1 — Done с committed-фото, заявка 2 — InProgress.
    const finalPull = await pull(technicianToken);
    const order1Item = finalPull.items.find(
      (item): item is ISyncPullOrderItem => item.type === 'order' && item.order.id === order1.id,
    );
    const order2Item = finalPull.items.find(
      (item): item is ISyncPullOrderItem => item.type === 'order' && item.order.id === order2.id,
    );
    expect(order1Item?.order.status).toBe('Done');
    expect(order1Item?.order.photos).toHaveLength(1);
    expect(order1Item?.order.photos[0]?.status).toBe('committed');
    expect(order2Item?.order.status).toBe('InProgress');
  });
});
