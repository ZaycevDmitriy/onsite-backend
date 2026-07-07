import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

// Импорт чужой db-schema допустим только на уровне схемы — для FK-ссылок.
import { users } from '../users/db-schema.js';

// Статусы записей push-очереди.
export const PushOutboxStatusEnum = {
  Pending: 'pending',
  Sent: 'sent',
  Failed: 'failed',
} as const;
export type PushOutboxStatusEnum = (typeof PushOutboxStatusEnum)[keyof typeof PushOutboxStatusEnum];

// Тикет Expo, полученный при отправке на конкретное устройство пользователя (стадия отправки);
// receipt-стадия сверяет id тикета с getPushNotificationReceiptsAsync (T-16).
export interface IOutboxTicket {
  token: string;
  ticketId: string;
}

// Устройства с Expo-push-токенами.
export const devices = pgTable(
  'devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    expoPushToken: text('expo_push_token').notNull().unique(),
    isActive: boolean('is_active').notNull().default(true),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('devices_user_id_idx').on(table.userId)],
);

// Очередь отложенной отправки push (outbox-паттерн, без прямых вызовов между модулями).
export const pushOutbox = pgTable(
  'push_outbox',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    message: jsonb('message').notNull(),
    status: text('status', {
      enum: [PushOutboxStatusEnum.Pending, PushOutboxStatusEnum.Sent, PushOutboxStatusEnum.Failed],
    })
      .notNull()
      .default(PushOutboxStatusEnum.Pending),
    attempts: integer('attempts').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // Forward-миграция T-16 (решение #1 фазы 6): receipt-стадия — тикеты Expo по каждому активному
    // устройству получателя (один outbox row адресован userId, не device — fan-out на N устройств,
    // FR-13), время отправки (для отсчёта PUSH_RECEIPT_DELAY_MIN) и текст последней ошибки.
    tickets: jsonb('tickets').$type<IOutboxTicket[]>(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    lastError: text('last_error'),
  },
  (table) => [
    index('push_outbox_status_idx').on(table.status),
    check('push_outbox_status_check', sql`${table.status} in ('pending', 'sent', 'failed')`),
  ],
);
