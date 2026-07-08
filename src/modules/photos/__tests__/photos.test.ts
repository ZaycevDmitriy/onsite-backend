import { randomUUID } from 'node:crypto';

import {
  CreateBucketCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { hash } from '@node-rs/argon2';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeTestConfig } from '@/__tests__/helpers/test-config.js';
import { buildApp } from '@/app.js';
import { refreshSessions } from '@/modules/auth/db-schema.js';
import { pushOutbox } from '@/modules/notifications/db-schema.js';
import { orderAssignments, orderEvents, orders } from '@/modules/orders/db-schema.js';
import { photos } from '@/modules/photos/db-schema.js';
import { PHOTO_COMMENT_MAX_LENGTH } from '@/modules/photos/domain.js';
import { cleanupOrphanStagedPhotos } from '@/modules/photos/index.js';
import { users } from '@/modules/users/db-schema.js';

import type { IAppConfig } from '@/shared/config/index.js';
import type { UserRoleEnum } from '@/modules/users/index.js';
import type { FastifyInstance } from 'fastify';

// Интеграционные тесты модуля фото (FR-11, FR-12, T-13): требуют реальной БД и MinIO/S3.
const databaseUrl = process.env.DATABASE_URL;
const s3Endpoint = process.env.S3_ENDPOINT;

const PASSWORD = 'photos-test-secret-1';
const EMAIL_PREFIX = 'photos-test-';

// Границы Content-Disposition в самодельном multipart-теле: light-my-request не умеет FormData.
const MULTIPART_BOUNDARY = '----photosTestBoundary1783412';

interface IMultipartField {
  name: string;
  value: string;
}

interface IMultipartFilePart {
  name: string;
  filename: string;
  contentType: string;
  data: Buffer;
}

const buildMultipartBody = (
  filePart: IMultipartFilePart | null,
  fields: IMultipartField[],
): { body: Buffer; contentType: string } => {
  const parts: Buffer[] = [];

  if (filePart !== null) {
    parts.push(
      Buffer.from(
        `--${MULTIPART_BOUNDARY}\r\n` +
          `Content-Disposition: form-data; name="${filePart.name}"; filename="${filePart.filename}"\r\n` +
          `Content-Type: ${filePart.contentType}\r\n\r\n`,
      ),
      filePart.data,
      Buffer.from('\r\n'),
    );
  }

  for (const field of fields) {
    parts.push(
      Buffer.from(
        `--${MULTIPART_BOUNDARY}\r\n` +
          `Content-Disposition: form-data; name="${field.name}"\r\n\r\n` +
          `${field.value}\r\n`,
      ),
    );
  }

  parts.push(Buffer.from(`--${MULTIPART_BOUNDARY}--\r\n`));

  return {
    body: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${MULTIPART_BOUNDARY}`,
  };
};

interface IPhotoView {
  id: string;
  orderId: string;
  authorId: string;
  status: string;
  comment: string | null;
  takenAt: string;
  createdAt: string;
}

interface IOrderView {
  id: string;
  status: string;
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

describe.runIf(databaseUrl && s3Endpoint)('модуль фото', () => {
  let app: FastifyInstance;
  let testS3: S3Client;
  let dispatcherToken: string;
  const createdUserIds: string[] = [];
  const createdOrderIds: string[] = [];
  const createdPhotoIds: string[] = [];
  const createdStorageKeys: string[] = [];

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
        title: 'Тестовая заявка для фото',
        client: 'Тестовый Клиент',
        address: 'ул. Тестовая, 1',
        description: 'Описание тестовой заявки для интеграционного теста фото.',
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

  // Валидный PNG-префикс: содержимое обязано соответствовать заявленному MIME-типу (магические байты).
  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const makePngBuffer = (payload: string): Buffer =>
    Buffer.concat([PNG_MAGIC, Buffer.from(payload, 'utf8')]);

  const uploadPhoto = async (options: {
    token: string;
    orderId: string;
    idempotencyKey?: string;
    mimeType?: string;
    fileBuffer?: Buffer;
    comment?: string;
    takenAt?: string;
    withIdempotencyKey?: boolean;
  }): Promise<{ statusCode: number; json: () => IPhotoView & { code?: string } }> => {
    const fields: IMultipartField[] = [
      { name: 'takenAt', value: options.takenAt ?? new Date().toISOString() },
    ];
    if (options.comment !== undefined) {
      fields.push({ name: 'comment', value: options.comment });
    }

    const { body, contentType } = buildMultipartBody(
      {
        name: 'file',
        filename: 'test.png',
        contentType: options.mimeType ?? 'image/png',
        data: options.fileBuffer ?? makePngBuffer('тестовые-байты-фото'),
      },
      fields,
    );

    const headers: Record<string, string> = {
      ...authHeaders(options.token),
      'content-type': contentType,
    };
    if (options.withIdempotencyKey !== false) {
      headers['idempotency-key'] = options.idempotencyKey ?? randomUUID();
    }

    const response = await app.inject({
      method: 'POST',
      url: `/v1/orders/${options.orderId}/photos`,
      headers,
      payload: body,
    });

    if (response.statusCode < 400) {
      const photo = response.json<IPhotoView>();
      createdPhotoIds.push(photo.id);
    }

    return response;
  };

  beforeAll(async () => {
    const config = makeTestConfig(databaseUrl as string);
    await ensureBucketExists(config);

    app = await buildApp(config);
    await app.ready();

    testS3 = new S3Client({
      endpoint: config.s3Endpoint,
      region: config.s3Region,
      credentials: { accessKeyId: config.s3AccessKey, secretAccessKey: config.s3SecretKey },
      forcePathStyle: true,
    });

    const dispatcher = await seedUser('dispatcher');
    dispatcherToken = await loginAs(dispatcher.email);
  });

  afterAll(async () => {
    for (const key of createdStorageKeys) {
      try {
        await testS3.send(new DeleteObjectCommand({ Bucket: app.s3.bucket, Key: key }));
      } catch {
        // Объект мог быть уже удалён зачисткой сирот — не фатально для очистки теста.
      }
    }
    testS3.destroy();

    if (createdPhotoIds.length > 0) {
      await app.db.delete(photos).where(inArray(photos.id, createdPhotoIds));
    }
    if (createdOrderIds.length > 0) {
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

  describe('staged-загрузка (FR-11)', () => {
    it('dispatcher загружает фото → 201 staged', async () => {
      const order = await createOrder();

      const response = await uploadPhoto({ token: dispatcherToken, orderId: order.id });

      expect(response.statusCode).toBe(201);
      const photo = response.json();
      expect(photo.status).toBe('staged');
      expect(photo.orderId).toBe(order.id);

      const key = (await app.db.select().from(photos).where(eq(photos.id, photo.id)))[0]
        ?.storageKey;
      if (key !== undefined) {
        createdStorageKeys.push(key);
      }
    });

    it('повтор с тем же Idempotency-Key → 200, та же запись, один объект в MinIO', async () => {
      const order = await createOrder();
      const idempotencyKey = randomUUID();
      const takenAt = '2026-01-01T10:00:00.000Z';

      const first = await uploadPhoto({
        token: dispatcherToken,
        orderId: order.id,
        idempotencyKey,
        takenAt,
        comment: 'исходный комментарий',
      });
      expect(first.statusCode).toBe(201);
      const firstPhoto = first.json();

      const second = await uploadPhoto({
        token: dispatcherToken,
        orderId: order.id,
        idempotencyKey,
        takenAt,
        comment: 'исходный комментарий',
      });
      expect(second.statusCode).toBe(200);
      const secondPhoto = second.json();
      expect(secondPhoto.id).toBe(firstPhoto.id);

      const row = (await app.db.select().from(photos).where(eq(photos.id, firstPhoto.id)))[0];
      expect(row).toBeDefined();
      const storageKey = row?.storageKey as string;
      createdStorageKeys.push(storageKey);

      const listed = await testS3.send(
        new ListObjectsV2Command({ Bucket: app.s3.bucket, Prefix: storageKey }),
      );
      expect(listed.Contents ?? []).toHaveLength(1);
    });

    it('тот же Idempotency-Key с другим comment → 409 conflict', async () => {
      const order = await createOrder();
      const idempotencyKey = randomUUID();
      const takenAt = '2026-01-01T10:00:00.000Z';

      const first = await uploadPhoto({
        token: dispatcherToken,
        orderId: order.id,
        idempotencyKey,
        takenAt,
        comment: 'первый комментарий',
      });
      expect(first.statusCode).toBe(201);
      const row = (await app.db.select().from(photos).where(eq(photos.id, first.json().id)))[0];
      if (row !== undefined) {
        createdStorageKeys.push(row.storageKey);
      }

      const second = await uploadPhoto({
        token: dispatcherToken,
        orderId: order.id,
        idempotencyKey,
        takenAt,
        comment: 'другой комментарий',
      });

      expect(second.statusCode).toBe(409);
      expect(second.json().code).toBe('conflict');
    });

    it('файл больше лимита → 413 file_too_large', async () => {
      const order = await createOrder();
      const oversized = Buffer.alloc(11 * 1024 * 1024, 1);

      const response = await uploadPhoto({
        token: dispatcherToken,
        orderId: order.id,
        fileBuffer: oversized,
      });

      expect(response.statusCode).toBe(413);
      expect(response.json().code).toBe('file_too_large');
    });

    it('PDF → 415 unsupported_media_type', async () => {
      const order = await createOrder();

      const response = await uploadPhoto({
        token: dispatcherToken,
        orderId: order.id,
        mimeType: 'application/pdf',
      });

      expect(response.statusCode).toBe(415);
      expect(response.json().code).toBe('unsupported_media_type');
    });

    it('содержимое не соответствует заявленному MIME-типу → 415 unsupported_media_type', async () => {
      const order = await createOrder();

      const response = await uploadPhoto({
        token: dispatcherToken,
        orderId: order.id,
        mimeType: 'image/png',
        fileBuffer: Buffer.from('не-png-содержимое', 'utf8'),
      });

      expect(response.statusCode).toBe(415);
      expect(response.json().code).toBe('unsupported_media_type');
    });

    it('comment длиннее лимита → 422 validation_failed', async () => {
      const order = await createOrder();

      const response = await uploadPhoto({
        token: dispatcherToken,
        orderId: order.id,
        comment: 'к'.repeat(PHOTO_COMMENT_MAX_LENGTH + 1),
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe('validation_failed');
    });

    it('без Idempotency-Key → 422 validation_failed', async () => {
      const order = await createOrder();

      const response = await uploadPhoto({
        token: dispatcherToken,
        orderId: order.id,
        withIdempotencyKey: false,
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe('validation_failed');
    });

    it('техник загружает фото к чужой заявке → 404', async () => {
      const order = await createOrder();
      const owner = await seedUser('technician');
      const stranger = await seedUser('technician');
      await assignTechnician(order.id, owner.id);
      const strangerToken = await loginAs(stranger.email);

      const response = await uploadPhoto({ token: strangerToken, orderId: order.id });

      expect(response.statusCode).toBe(404);
    });

    it('staged-фото не видно в GET /v1/orders/:id', async () => {
      const order = await createOrder();
      const uploaded = await uploadPhoto({ token: dispatcherToken, orderId: order.id });
      const row = (await app.db.select().from(photos).where(eq(photos.id, uploaded.json().id)))[0];
      if (row !== undefined) {
        createdStorageKeys.push(row.storageKey);
      }

      const response = await app.inject({
        method: 'GET',
        url: `/v1/orders/${order.id}`,
        headers: authHeaders(dispatcherToken),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json<{ photos: unknown[] }>().photos).toEqual([]);
    });
  });

  describe('выдача файла (FR-12)', () => {
    it('GET /v1/photos/:id/file → 302 с presigned Location, URL отдаёт загруженные байты', async () => {
      const order = await createOrder();
      const fileBuffer = makePngBuffer('уникальное-содержимое-для-проверки');

      const uploaded = await uploadPhoto({ token: dispatcherToken, orderId: order.id, fileBuffer });
      expect(uploaded.statusCode).toBe(201);
      const photo = uploaded.json();
      const row = (await app.db.select().from(photos).where(eq(photos.id, photo.id)))[0];
      if (row !== undefined) {
        createdStorageKeys.push(row.storageKey);
      }

      const response = await app.inject({
        method: 'GET',
        url: `/v1/photos/${photo.id}/file`,
        headers: authHeaders(dispatcherToken),
      });

      expect(response.statusCode).toBe(302);
      const location = response.headers['location'] as string;
      expect(location).toBeDefined();

      const downloaded = await fetch(location);
      expect(downloaded.status).toBe(200);
      const downloadedBuffer = Buffer.from(await downloaded.arrayBuffer());
      expect(downloadedBuffer.equals(fileBuffer)).toBe(true);
    });

    it('чужое staged-фото для техника → 404', async () => {
      const order = await createOrder();
      const stranger = await seedUser('technician');
      const strangerToken = await loginAs(stranger.email);

      const uploaded = await uploadPhoto({ token: dispatcherToken, orderId: order.id });
      const photo = uploaded.json();
      const row = (await app.db.select().from(photos).where(eq(photos.id, photo.id)))[0];
      if (row !== undefined) {
        createdStorageKeys.push(row.storageKey);
      }

      const response = await app.inject({
        method: 'GET',
        url: `/v1/photos/${photo.id}/file`,
        headers: authHeaders(strangerToken),
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('зачистка staged-сирот (T-13)', () => {
    it('staged старше TTL удаляется из БД и S3, свежий — остаётся', async () => {
      const order = await createOrder();

      const old = await uploadPhoto({ token: dispatcherToken, orderId: order.id });
      const fresh = await uploadPhoto({ token: dispatcherToken, orderId: order.id });
      const oldPhoto = old.json();
      const freshPhoto = fresh.json();

      const oldRow = (await app.db.select().from(photos).where(eq(photos.id, oldPhoto.id)))[0];
      const freshRow = (await app.db.select().from(photos).where(eq(photos.id, freshPhoto.id)))[0];
      const oldKey = oldRow?.storageKey as string;
      const freshKey = freshRow?.storageKey as string;

      // Подделываем created_at: старое фото — 2 часа назад (истекло при TTL=1ч), свежее — не трогаем.
      await app.db
        .update(photos)
        .set({ createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
        .where(eq(photos.id, oldPhoto.id));

      const result = await cleanupOrphanStagedPhotos(app.db, app.s3, 1, app.log);

      expect(result.deleted).toBeGreaterThanOrEqual(1);

      const remainingOld = await app.db.select().from(photos).where(eq(photos.id, oldPhoto.id));
      expect(remainingOld).toHaveLength(0);

      const remainingFresh = await app.db.select().from(photos).where(eq(photos.id, freshPhoto.id));
      expect(remainingFresh).toHaveLength(1);
      createdStorageKeys.push(freshKey);
      // oldPhoto уже удалён из БД зачисткой — не добавляем в createdPhotoIds/createdStorageKeys повторно.

      const oldObjectListing = await testS3.send(
        new ListObjectsV2Command({ Bucket: app.s3.bucket, Prefix: oldKey }),
      );
      expect(oldObjectListing.Contents ?? []).toHaveLength(0);
    });
  });
});
