import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

// Импорт чужой db-schema допустим только на уровне схемы — для FK-ссылок.
import { users } from '../users/db-schema.js';

// Результаты применения мутации синк-батча.
export const SyncMutationResultEnum = {
  Applied: 'applied',
  Duplicate: 'duplicate',
  Conflict: 'conflict',
  Rejected: 'rejected',
} as const;
export type SyncMutationResultEnum =
  (typeof SyncMutationResultEnum)[keyof typeof SyncMutationResultEnum];

// Реестр обработанных мутаций: mutation_id клиента — ключ идемпотентности (FR-09).
export const syncMutations = pgTable(
  'sync_mutations',
  {
    mutationId: uuid('mutation_id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    result: text('result', {
      enum: [
        SyncMutationResultEnum.Applied,
        SyncMutationResultEnum.Duplicate,
        SyncMutationResultEnum.Conflict,
        SyncMutationResultEnum.Rejected,
      ],
    }).notNull(),
    // Зафиксированный вердикт: повторный запрос отвечает байт-в-байт тем же результатом.
    response: jsonb('response').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('sync_mutations_user_id_idx').on(table.userId),
    check(
      'sync_mutations_result_check',
      sql`${table.result} in ('applied', 'duplicate', 'conflict', 'rejected')`,
    ),
  ],
);
