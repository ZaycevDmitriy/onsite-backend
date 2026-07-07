import { and, eq } from 'drizzle-orm';

import { syncMutations } from './db-schema.js';

import type { SyncMutationResultEnum } from './db-schema.js';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

// Строка таблицы sync_mutations как её видит Drizzle.
export type ISyncMutationRow = typeof syncMutations.$inferSelect;

// Транзакционный или обычный клиент Drizzle — заявка идемпотентности идёт внутри транзакции мутации.
export type DbClient = NodePgDatabase | Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0];

export interface IInsertSyncMutationInput {
  mutationId: string;
  userId: string;
  result: SyncMutationResultEnum;
  response: unknown;
}

/**
 * Ищет ранее обработанную мутацию по mutationId в пределах пользователя (идемпотентность, FR-09).
 * Скоупинг по userId обязателен: чужой mutationId не должен раскрывать сохранённый вердикт
 * со снимком чужой заявки (см. security-аудит фазы 5).
 */
export const findSyncMutationById = async (
  db: DbClient,
  mutationId: string,
  userId: string,
): Promise<ISyncMutationRow | null> => {
  const rows = await db
    .select()
    .from(syncMutations)
    .where(and(eq(syncMutations.mutationId, mutationId), eq(syncMutations.userId, userId)))
    .limit(1);

  return rows[0] ?? null;
};

/**
 * Фиксирует вердикт обработанной мутации (FR-09, решение #4 фазы 5).
 * mutationId — первичный ключ: конкурентная гонка ловится по нарушению 23505 (isUniqueViolation).
 */
export const insertSyncMutation = async (
  db: DbClient,
  input: IInsertSyncMutationInput,
): Promise<void> => {
  await db.insert(syncMutations).values(input);
};
