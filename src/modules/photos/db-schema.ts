import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

// Импорт чужой db-schema допустим только на уровне схемы — для FK-ссылок.
import { orders } from '../orders/db-schema.js';
import { users } from '../users/db-schema.js';

// Статусы фото: staged после загрузки бинарника, committed после мутации photo_add.
export const PhotoStatusEnum = {
  Staged: 'staged',
  Committed: 'committed',
} as const;
export type PhotoStatusEnum = (typeof PhotoStatusEnum)[keyof typeof PhotoStatusEnum];

// Фотоотчёты по заявкам; бинарники — в S3, здесь метаданные и storage_key.
export const photos = pgTable(
  'photos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id),
    status: text('status', { enum: [PhotoStatusEnum.Staged, PhotoStatusEnum.Committed] })
      .notNull()
      .default(PhotoStatusEnum.Staged),
    storageKey: text('storage_key').notNull(),
    comment: text('comment'),
    // occurredAt клиента — момент съёмки.
    takenAt: timestamp('taken_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('photos_order_id_idx').on(table.orderId),
    // Идемпотентность загрузки: storage_key детерминирован по (orderId, authorId, Idempotency-Key) (решение #1, #2).
    uniqueIndex('photos_storage_key_unique').on(table.storageKey),
    check('photos_status_check', sql`${table.status} in ('staged', 'committed')`),
  ],
);
