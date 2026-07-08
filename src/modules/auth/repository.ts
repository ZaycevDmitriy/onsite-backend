import { and, eq, inArray, isNull, lt } from 'drizzle-orm';

import { refreshSessions } from './db-schema.js';

import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

// Строка таблицы refresh_sessions как её видит Drizzle.
export type IRefreshSessionRow = typeof refreshSessions.$inferSelect;

// Транзакционный или обычный клиент Drizzle — операции ротации идут в транзакции.
export type DbClient = NodePgDatabase | Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0];

export interface IInsertSessionInput {
  userId: string;
  tokenHash: string;
  familyId: string;
  expiresAt: Date;
}

/** Ищет сессию по хешу токена (сам токен в БД не хранится). */
export const findSessionByTokenHash = async (
  db: DbClient,
  tokenHash: string,
): Promise<IRefreshSessionRow | null> => {
  const rows = await db
    .select()
    .from(refreshSessions)
    .where(eq(refreshSessions.tokenHash, tokenHash))
    .limit(1);

  return rows[0] ?? null;
};

/** Создаёт новую refresh-сессию. */
export const insertSession = async (
  db: DbClient,
  input: IInsertSessionInput,
): Promise<IRefreshSessionRow> => {
  const rows = await db.insert(refreshSessions).values(input).returning();

  return rows[0] as IRefreshSessionRow;
};

/**
 * Отзывает одну живую сессию по id.
 * Возвращает false, если сессия уже отозвана конкурентной ротацией —
 * вызывающий обязан трактовать это как replay.
 */
export const revokeSessionById = async (db: DbClient, id: string): Promise<boolean> => {
  const revoked = await db
    .update(refreshSessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshSessions.id, id), isNull(refreshSessions.revokedAt)))
    .returning({ id: refreshSessions.id });

  return revoked.length > 0;
};

/** Отзывает все живые сессии семьи (replay-защита FR-02). */
export const revokeFamilySessions = async (db: DbClient, familyId: string): Promise<void> => {
  await db
    .update(refreshSessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshSessions.familyId, familyId), isNull(refreshSessions.revokedAt)));
};

/** Отзывает все живые сессии пользователя (сброс пароля, §9.8). */
export const revokeSessionsByUserId = async (db: DbClient, userId: string): Promise<void> => {
  await db
    .update(refreshSessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshSessions.userId, userId), isNull(refreshSessions.revokedAt)));
};

/**
 * Удаляет одну пачку сессий, истекших раньше olderThan (не по revokedAt — просроченная
 * отозванная строка теряет ценность для replay-детекции независимо от revokedAt).
 * Батч через подзапрос с LIMIT — DELETE без LIMIT в pg недоступен.
 * Возвращает число удалённых строк.
 */
export const deleteExpiredSessions = async (
  db: DbClient,
  olderThan: Date,
  batchLimit: number,
): Promise<number> => {
  const candidates = db
    .select({ id: refreshSessions.id })
    .from(refreshSessions)
    .where(lt(refreshSessions.expiresAt, olderThan))
    .limit(batchLimit);

  const deleted = await db
    .delete(refreshSessions)
    .where(inArray(refreshSessions.id, candidates))
    .returning({ id: refreshSessions.id });

  return deleted.length;
};
