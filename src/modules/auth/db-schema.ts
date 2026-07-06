import { pgTable, text, timestamp, uuid, index } from 'drizzle-orm/pg-core';

// Импорт чужой db-schema допустим только на уровне схемы — для FK-ссылок.
import { users } from '../users/db-schema.js';

// Refresh-сессии с ротацией: family_id связывает цепочку токенов, replay отзывает семью.
export const refreshSessions = pgTable(
  'refresh_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    // Хеш refresh-токена; сам токен не хранится.
    tokenHash: text('token_hash').notNull(),
    familyId: uuid('family_id').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    index('refresh_sessions_user_id_idx').on(table.userId),
    index('refresh_sessions_family_id_idx').on(table.familyId),
  ],
);
