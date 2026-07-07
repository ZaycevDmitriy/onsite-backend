import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { findOrderForAccess } from '@/modules/orders/index.js';
import { UserRoleEnum } from '@/modules/users/index.js';
import { isUniqueViolation } from '@/shared/db/index.js';
import { AppError, ErrorCodeEnum } from '@/shared/errors/index.js';

import { PhotoStatusEnum } from './db-schema.js';
import { buildStorageKey, isAllowedMimeType, matchesDeclaredMimeType } from './domain.js';
import {
  deletePhotoById,
  findPhotoById,
  findPhotoByStorageKey,
  insertPhoto,
  listCommittedPhotosByOrderId as listCommittedPhotosByOrderIdRepo,
  listExpiredStagedPhotos,
} from './repository.js';

import type { IPhotoRow } from './repository.js';
import type { IS3Decoration } from '@/shared/plugins/index.js';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { FastifyBaseLogger } from 'fastify';

// Заявитель операции фото: id + роль (проверка доступа зеркалит orders, решение #6).
export interface IPhotoRequester {
  id: string;
  role: UserRoleEnum;
}

// Представление фото для API: даты — ISO 8601 UTC.
export interface IPhotoView {
  id: string;
  orderId: string;
  authorId: string;
  status: PhotoStatusEnum;
  comment: string | null;
  takenAt: string;
  createdAt: string;
}

export interface IUploadStagedPhotoInput {
  orderId: string;
  idempotencyKey: string;
  mimeType: string;
  fileBuffer: Buffer;
  comment?: string;
  takenAt: Date;
}

export interface IUploadStagedPhotoResult {
  photo: IPhotoView;
  // true — новая запись (201), false — идемпотентный повтор, та же запись (200, решение #1).
  created: boolean;
}

export interface IPhotoFileLocation {
  url: string;
}

export interface ICleanupResult {
  found: number;
  deleted: number;
  errors: number;
}

// Размер пачки за один прогон зачистки сирот — не блокировать воркер на большом бэклоге.
const CLEANUP_BATCH_LIMIT = 100;

const toPhotoView = (row: IPhotoRow): IPhotoView => ({
  id: row.id,
  orderId: row.orderId,
  authorId: row.authorId,
  status: row.status,
  comment: row.comment,
  takenAt: row.takenAt.toISOString(),
  createdAt: row.createdAt.toISOString(),
});

/** Заявка не найдена или чужая для техника (зеркало правила orders, FR-03/FR-11) → 404. */
const assertOrderAccessible = async (
  db: NodePgDatabase,
  orderId: string,
  requester: IPhotoRequester,
  logger: FastifyBaseLogger,
): Promise<void> => {
  const order = await findOrderForAccess(db, orderId);

  if (
    order === null ||
    (requester.role === UserRoleEnum.Technician && order.assignedTo !== requester.id)
  ) {
    logger.debug({ orderId }, 'заявка не найдена или не принадлежит технику');
    throw new AppError(404, ErrorCodeEnum.NotFound, 'Order not found');
  }
};

const isNoSuchKeyError = (error: unknown): boolean =>
  error instanceof Error &&
  ((error as { name?: string }).name === 'NoSuchKey' ||
    (error as { Code?: string }).Code === 'NoSuchKey');

/**
 * Staged-загрузка фото (FR-11): доступ по правилам заявки → идемпотентный поиск по storage_key
 * (совпадение payload — 200-ветка, расхождение comment/takenAt — 409) → PutObject → insert
 * (гонка конкурентной идентичной загрузки — 23505 → перечитать существующую запись).
 */
export const uploadStagedPhoto = async (
  db: NodePgDatabase,
  s3: IS3Decoration,
  input: IUploadStagedPhotoInput,
  requester: IPhotoRequester,
  logger: FastifyBaseLogger,
): Promise<IUploadStagedPhotoResult> => {
  logger.debug({ orderId: input.orderId }, 'загрузка фото: старт');

  await assertOrderAccessible(db, input.orderId, requester, logger);

  if (!isAllowedMimeType(input.mimeType)) {
    logger.debug({ mimeType: input.mimeType }, 'загрузка фото отклонена: недопустимый тип файла');
    throw new AppError(415, ErrorCodeEnum.UnsupportedMediaType, 'Unsupported file type');
  }

  if (!matchesDeclaredMimeType(input.fileBuffer, input.mimeType)) {
    logger.debug(
      { mimeType: input.mimeType },
      'загрузка фото отклонена: содержимое не соответствует заявленному типу',
    );
    throw new AppError(415, ErrorCodeEnum.UnsupportedMediaType, 'Unsupported file type');
  }

  const storageKey = buildStorageKey(input.orderId, requester.id, input.idempotencyKey);

  const existing = await findPhotoByStorageKey(db, storageKey);

  if (existing !== null) {
    const commentMatches = (existing.comment ?? null) === (input.comment ?? null);
    const takenAtMatches = existing.takenAt.getTime() === input.takenAt.getTime();

    if (!commentMatches || !takenAtMatches) {
      logger.debug(
        { storageKey },
        'загрузка фото отклонена: Idempotency-Key переиспользован с другим payload',
      );
      throw new AppError(
        409,
        ErrorCodeEnum.Conflict,
        'Idempotency key reused with different payload',
      );
    }

    logger.info({ photoId: existing.id }, 'загрузка фото: идемпотентный повтор');

    return { photo: toPhotoView(existing), created: false };
  }

  logger.debug(
    { storageKey, size: input.fileBuffer.byteLength },
    'загрузка фото: запись объекта в S3',
  );

  await s3.client.send(
    new PutObjectCommand({
      Bucket: s3.bucket,
      Key: storageKey,
      Body: input.fileBuffer,
      ContentType: input.mimeType,
    }),
  );

  let row: IPhotoRow;
  try {
    row = await insertPhoto(db, {
      orderId: input.orderId,
      authorId: requester.id,
      storageKey,
      ...(input.comment !== undefined ? { comment: input.comment } : {}),
      takenAt: input.takenAt,
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      const raced = await findPhotoByStorageKey(db, storageKey);

      if (raced !== null) {
        logger.info({ photoId: raced.id }, 'загрузка фото: гонка конкурентной вставки, перечитана');

        return { photo: toPhotoView(raced), created: false };
      }
    }

    logger.error({ err: error, storageKey }, 'ошибка вставки записи фото после S3-загрузки');
    throw error;
  }

  logger.info({ photoId: row.id, orderId: input.orderId }, 'фото загружено (staged)');

  return { photo: toPhotoView(row), created: true };
};

/**
 * Выдача файла фото (FR-12): committed — по правилам заявки, staged — только автору;
 * чужое/несуществующее → 404. Возвращает presigned URL публичного клиента.
 */
export const getPhotoFileLocation = async (
  db: NodePgDatabase,
  s3: IS3Decoration,
  id: string,
  requester: IPhotoRequester,
  presignTtlSec: number,
  logger: FastifyBaseLogger,
): Promise<IPhotoFileLocation> => {
  logger.debug({ photoId: id }, 'выдача файла фото: старт');

  const photo = await findPhotoById(db, id);

  if (photo === null) {
    logger.debug({ photoId: id }, 'фото не найдено');
    throw new AppError(404, ErrorCodeEnum.NotFound, 'Photo not found');
  }

  if (photo.status === PhotoStatusEnum.Staged) {
    if (photo.authorId !== requester.id) {
      logger.debug({ photoId: id }, 'staged-фото доступно только автору');
      throw new AppError(404, ErrorCodeEnum.NotFound, 'Photo not found');
    }
  } else {
    await assertOrderAccessible(db, photo.orderId, requester, logger);
  }

  const url = await getSignedUrl(
    s3.presignClient,
    new GetObjectCommand({ Bucket: s3.bucket, Key: photo.storageKey }),
    { expiresIn: presignTtlSec },
  );

  logger.info({ photoId: id }, 'выдан presigned URL файла фото');

  return { url };
};

/** Committed-фото заявки для GET /v1/orders/:id (§5.6, решение #10). */
export const listCommittedPhotosByOrderId = async (
  db: NodePgDatabase,
  orderId: string,
): Promise<IPhotoView[]> => {
  const rows = await listCommittedPhotosByOrderIdRepo(db, orderId);

  return rows.map(toPhotoView);
};

/**
 * Ищет staged-фото по id — задел под мутацию photo_add фазы 5 (решение #11), в фазе 4 не вызывается.
 */
export const findStagedPhotoForCommit = async (
  db: NodePgDatabase,
  id: string,
): Promise<IPhotoRow | null> => {
  const row = await findPhotoById(db, id);

  return row !== null && row.status === PhotoStatusEnum.Staged ? row : null;
};

/**
 * Зачистка staged-сирот (T-13): старше ttlHours → удалить объект S3 (NoSuchKey не фатален) → удалить запись.
 */
export const cleanupOrphanStagedPhotos = async (
  db: NodePgDatabase,
  s3: IS3Decoration,
  ttlHours: number,
  logger: FastifyBaseLogger,
): Promise<ICleanupResult> => {
  const olderThan = new Date(Date.now() - ttlHours * 3_600_000);
  const candidates = await listExpiredStagedPhotos(db, olderThan, CLEANUP_BATCH_LIMIT);

  logger.debug({ count: candidates.length }, 'зачистка staged-сирот: найдены кандидаты');

  let deleted = 0;
  let errors = 0;

  for (const photo of candidates) {
    try {
      try {
        await s3.client.send(new DeleteObjectCommand({ Bucket: s3.bucket, Key: photo.storageKey }));
      } catch (error) {
        if (!isNoSuchKeyError(error)) {
          throw error;
        }
      }

      await deletePhotoById(db, photo.id);
      deleted += 1;
    } catch (error) {
      errors += 1;
      logger.error({ err: error, photoId: photo.id }, 'ошибка зачистки staged-фото');
    }
  }

  logger.info({ found: candidates.length, deleted, errors }, 'зачистка staged-сирот завершена');

  return { found: candidates.length, deleted, errors };
};
