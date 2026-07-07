import { and, asc, eq, inArray, lt } from 'drizzle-orm';

import { photos, PhotoStatusEnum } from './db-schema.js';

import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

// Строка таблицы photos как её видит Drizzle.
export type IPhotoRow = typeof photos.$inferSelect;

// Транзакционный или обычный клиент Drizzle — гонка при staged-загрузке ловится внутри транзакции.
export type DbClient = NodePgDatabase | Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0];

export interface IInsertPhotoInput {
  orderId: string;
  authorId: string;
  storageKey: string;
  comment?: string;
  takenAt: Date;
}

/** Вставляет новую staged-запись фото. */
export const insertPhoto = async (db: DbClient, input: IInsertPhotoInput): Promise<IPhotoRow> => {
  const rows = await db.insert(photos).values(input).returning();

  // returning() по одной записи всегда отдаёт ровно одну строку.
  return rows[0] as IPhotoRow;
};

/** Ищет фото по id. */
export const findPhotoById = async (db: DbClient, id: string): Promise<IPhotoRow | null> => {
  const rows = await db.select().from(photos).where(eq(photos.id, id)).limit(1);

  return rows[0] ?? null;
};

/** Ищет фото по детерминированному storage_key — основа идемпотентности загрузки (решение #1). */
export const findPhotoByStorageKey = async (
  db: DbClient,
  storageKey: string,
): Promise<IPhotoRow | null> => {
  const rows = await db.select().from(photos).where(eq(photos.storageKey, storageKey)).limit(1);

  return rows[0] ?? null;
};

/** Committed-фото заявки в порядке съёмки (§5.6, GET /v1/orders/:id). */
export const listCommittedPhotosByOrderId = async (
  db: DbClient,
  orderId: string,
): Promise<IPhotoRow[]> =>
  db
    .select()
    .from(photos)
    .where(and(eq(photos.orderId, orderId), eq(photos.status, PhotoStatusEnum.Committed)))
    .orderBy(asc(photos.takenAt));

/** Committed-фото нескольких заявок разом (pull-синхронизация, решение #2 фазы 5) — без N+1. */
export const listCommittedPhotosByOrderIds = async (
  db: DbClient,
  orderIds: string[],
): Promise<IPhotoRow[]> =>
  db
    .select()
    .from(photos)
    .where(and(inArray(photos.orderId, orderIds), eq(photos.status, PhotoStatusEnum.Committed)))
    .orderBy(asc(photos.takenAt));

/**
 * Переводит фото staged → committed (мутация photo_add, §5.6, решение #6 фазы 5).
 * Условие status = staged в WHERE — гонка с повторной обработкой той же мутации не удвоит переход.
 * null — фото не найдено или уже не staged.
 */
export const commitPhotoById = async (db: DbClient, id: string): Promise<IPhotoRow | null> => {
  const rows = await db
    .update(photos)
    .set({ status: PhotoStatusEnum.Committed })
    .where(and(eq(photos.id, id), eq(photos.status, PhotoStatusEnum.Staged)))
    .returning();

  return rows[0] ?? null;
};

/** Staged-фото старше olderThan — кандидаты на зачистку сирот (T-13). */
export const listExpiredStagedPhotos = async (
  db: DbClient,
  olderThan: Date,
  limit: number,
): Promise<IPhotoRow[]> =>
  db
    .select()
    .from(photos)
    .where(and(eq(photos.status, PhotoStatusEnum.Staged), lt(photos.createdAt, olderThan)))
    .limit(limit);

/** Удаляет запись фото по id (после удаления объекта из S3 при зачистке сирот). */
export const deletePhotoById = async (db: DbClient, id: string): Promise<void> => {
  await db.delete(photos).where(eq(photos.id, id));
};
