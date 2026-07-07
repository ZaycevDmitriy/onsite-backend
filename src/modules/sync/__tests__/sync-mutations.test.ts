import { randomUUID } from 'node:crypto';

import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { hash } from '@node-rs/argon2';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeTestConfig } from '@/__tests__/helpers/test-config.js';
import { buildApp } from '@/app.js';
import { refreshSessions } from '@/modules/auth/db-schema.js';
import { orderAssignments, orderEvents, orders } from '@/modules/orders/db-schema.js';
import { photos } from '@/modules/photos/db-schema.js';
import { users } from '@/modules/users/db-schema.js';
import { syncMutations } from '@/modules/sync/db-schema.js';

import type { IAppConfig } from '@/shared/config/index.js';
import type { UserRoleEnum } from '@/modules/users/index.js';
import type { FastifyInstance } from 'fastify';

// Интеграционные тесты батча мутаций (FR-09/FR-10, §5.6): требуют реальной БД и MinIO/S3.
const databaseUrl = process.env.DATABASE_URL;
const s3Endpoint = process.env.S3_ENDPOINT;

const PASSWORD = 'sync-mutations-test-secret-1';
const EMAIL_PREFIX = 'sync-mutations-test-';

// Границы Content-Disposition в самодельном multipart-теле: light-my-request не умеет FormData.
const MULTIPART_BOUNDARY = '----syncMutationsTestBoundary8823101';
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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

describe.runIf(databaseUrl && s3Endpoint)('sync mutations (FR-09/FR-10)', () => {
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

  const createOrder = async (): Promise<IOrderView> => {
    const now = Date.now();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: authHeaders(dispatcherToken),
      payload: {
        title: 'Тестовая заявка мутаций синка',
        client: 'Тестовый Клиент',
        address: 'ул. Тестовая, 1',
        description: 'Описание тестовой заявки для мутаций sync.',
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

  const transitionAsDispatcher = async (
    orderId: string,
    to: string,
    baseStatus: string,
  ): Promise<void> => {
    const response = await app.inject({
      method: 'POST',
      url: `/v1/orders/${orderId}/transition`,
      headers: authHeaders(dispatcherToken),
      payload: { to, baseStatus },
    });
    expect(response.statusCode).toBe(200);
  };

  const uploadStagedPhoto = async (token: string, orderId: string): Promise<IPhotoView> => {
    const idempotencyKey = randomUUID();
    const fileBuffer = Buffer.concat([PNG_MAGIC, Buffer.from('sync-mutations-photo', 'utf8')]);
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
    for (const mutation of mutations) {
      createdMutationIds.push(mutation['mutationId'] as string);
    }

    const response = await app.inject({
      method: 'POST',
      url: '/v1/sync/mutations',
      headers: authHeaders(token),
      payload: { mutations },
    });
    expect(response.statusCode).toBe(200);

    return response.json<{ verdicts: ISyncMutationVerdict[] }>().verdicts;
  };

  beforeAll(async () => {
    const config = makeTestConfig(databaseUrl as string);
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
      await app.db.delete(users).where(inArray(users.id, createdUserIds));
    }
    await app.close();
  });

  it('ретрай того же батча → все мутации duplicate с исходным вердиктом, состояние не меняется', async () => {
    const technician = await seedUser('technician');
    const technicianToken = await loginAs(technician.email);
    const order = await createOrder();
    await assignTechnician(order.id, technician.id);
    await transitionAsDispatcher(order.id, 'InProgress', 'New');

    const photo = await uploadStagedPhoto(technicianToken, order.id);

    const statusMutationId = randomUUID();
    const photoMutationId = randomUUID();
    const batch = [
      {
        mutationId: statusMutationId,
        type: 'status_change',
        orderId: order.id,
        to: 'Done',
        baseStatus: 'InProgress',
      },
      { mutationId: photoMutationId, type: 'photo_add', orderId: order.id, photoId: photo.id },
    ];

    const first = await submitMutations(technicianToken, batch);
    const firstStatus = first.find((v) => v.mutationId === statusMutationId);
    const firstPhoto = first.find((v) => v.mutationId === photoMutationId);
    expect(firstStatus?.result).toBe('applied');
    expect(firstStatus?.order?.status).toBe('Done');
    expect(firstPhoto?.result).toBe('applied');

    const second = await submitMutations(technicianToken, batch);
    const secondStatus = second.find((v) => v.mutationId === statusMutationId);
    const secondPhoto = second.find((v) => v.mutationId === photoMutationId);
    expect(secondStatus?.result).toBe('duplicate');
    expect(secondStatus?.order).toEqual(firstStatus?.order);
    expect(secondPhoto?.result).toBe('duplicate');

    // Состояние БД не изменилось повторной обработкой: по одному sync-событию каждого типа
    // (status_changed от dispatcher-настройки InProgress учитывается отдельно, source='api').
    const events = await app.db.select().from(orderEvents).where(eq(orderEvents.orderId, order.id));
    expect(
      events.filter((event) => event.type === 'status_changed' && event.source === 'sync'),
    ).toHaveLength(1);
    expect(events.filter((event) => event.type === 'photo_added')).toHaveLength(1);

    const photoRow = (await app.db.select().from(photos).where(eq(photos.id, photo.id)))[0];
    expect(photoRow?.status).toBe('committed');
  });

  it('конфликт status_change (заявка отменена диспетчером) → conflict со снимком Cancelled', async () => {
    const technician = await seedUser('technician');
    const technicianToken = await loginAs(technician.email);
    const order = await createOrder();
    await assignTechnician(order.id, technician.id);
    await transitionAsDispatcher(order.id, 'Cancelled', 'New');

    const verdicts = await submitMutations(technicianToken, [
      {
        mutationId: randomUUID(),
        type: 'status_change',
        orderId: order.id,
        to: 'InProgress',
        baseStatus: 'New',
      },
    ]);

    expect(verdicts[0]?.result).toBe('conflict');
    expect(verdicts[0]?.order?.status).toBe('Cancelled');

    const events = await app.db.select().from(orderEvents).where(eq(orderEvents.orderId, order.id));
    expect(events.some((event) => event.type === 'sync_conflict')).toBe(true);
  });

  it('photo_add к отменённой (Cancelled) заявке → applied', async () => {
    const technician = await seedUser('technician');
    const technicianToken = await loginAs(technician.email);
    const order = await createOrder();
    await assignTechnician(order.id, technician.id);

    const photo = await uploadStagedPhoto(technicianToken, order.id);
    await transitionAsDispatcher(order.id, 'Cancelled', 'New');

    const verdicts = await submitMutations(technicianToken, [
      { mutationId: randomUUID(), type: 'photo_add', orderId: order.id, photoId: photo.id },
    ]);

    expect(verdicts[0]?.result).toBe('applied');

    const photoRow = (await app.db.select().from(photos).where(eq(photos.id, photo.id)))[0];
    expect(photoRow?.status).toBe('committed');
  });

  it('неизвестный photoId → rejected', async () => {
    const technician = await seedUser('technician');
    const technicianToken = await loginAs(technician.email);
    const order = await createOrder();
    await assignTechnician(order.id, technician.id);

    const verdicts = await submitMutations(technicianToken, [
      { mutationId: randomUUID(), type: 'photo_add', orderId: order.id, photoId: randomUUID() },
    ]);

    expect(verdicts[0]?.result).toBe('rejected');
  });

  it('чужое staged-фото (authorId ≠ техник мутации) → rejected', async () => {
    const owner = await seedUser('technician');
    const ownerToken = await loginAs(owner.email);
    const stranger = await seedUser('technician');
    const strangerToken = await loginAs(stranger.email);
    const order = await createOrder();
    await assignTechnician(order.id, owner.id);

    const photo = await uploadStagedPhoto(ownerToken, order.id);

    const verdicts = await submitMutations(strangerToken, [
      { mutationId: randomUUID(), type: 'photo_add', orderId: order.id, photoId: photo.id },
    ]);

    expect(verdicts[0]?.result).toBe('rejected');

    const photoRow = (await app.db.select().from(photos).where(eq(photos.id, photo.id)))[0];
    expect(photoRow?.status).toBe('staged');
  });
});
