import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  check,
  doublePrecision,
  index,
  jsonb,
  pgSequence,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

// Импорт чужой db-schema допустим только на уровне схемы — для FK-ссылок.
import { users } from '../users/db-schema.js';

// Статусы заявки — зеркало клиентского ServiceOrderStatusEnum.
export const ServiceOrderStatusEnum = {
  New: 'New',
  InProgress: 'InProgress',
  Done: 'Done',
  Cancelled: 'Cancelled',
} as const;
export type ServiceOrderStatusEnum =
  (typeof ServiceOrderStatusEnum)[keyof typeof ServiceOrderStatusEnum];

// Типы событий журнала заявки.
export const OrderEventTypeEnum = {
  Created: 'created',
  Assigned: 'assigned',
  StatusChanged: 'status_changed',
  PhotoAdded: 'photo_added',
  SyncConflict: 'sync_conflict',
} as const;
export type OrderEventTypeEnum = (typeof OrderEventTypeEnum)[keyof typeof OrderEventTypeEnum];

// Общая последовательность курсора синка: и orders.updated_seq, и
// order_assignments.unassigned_seq берут значения из неё (§5.5, tombstone).
export const syncSeq = pgSequence('sync_seq');

// Заявки: владелец таблицы — модуль orders.
export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    status: text('status', {
      enum: [
        ServiceOrderStatusEnum.New,
        ServiceOrderStatusEnum.InProgress,
        ServiceOrderStatusEnum.Done,
        ServiceOrderStatusEnum.Cancelled,
      ],
    })
      .notNull()
      .default(ServiceOrderStatusEnum.New),
    title: text('title').notNull(),
    client: text('client').notNull(),
    address: text('address').notNull(),
    description: text('description').notNull(),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
    slotStart: timestamp('slot_start', { withTimezone: true }).notNull(),
    slotEnd: timestamp('slot_end', { withTimezone: true }).notNull(),
    latitude: doublePrecision('latitude'),
    longitude: doublePrecision('longitude'),
    assignedTo: uuid('assigned_to').references(() => users.id),
    // Курсор синка: каждая запись заявки получает новое значение из sync_seq.
    updatedSeq: bigint('updated_seq', { mode: 'number' })
      .notNull()
      .default(sql`nextval('sync_seq')`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('orders_updated_seq_idx').on(table.updatedSeq),
    index('orders_assigned_to_idx').on(table.assignedTo),
    index('orders_status_idx').on(table.status),
    check(
      'orders_status_check',
      sql`${table.status} in ('New', 'InProgress', 'Done', 'Cancelled')`,
    ),
  ],
);

// Журнал событий заявки (append-only).
export const orderEvents = pgTable(
  'order_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => users.id),
    type: text('type', {
      enum: [
        OrderEventTypeEnum.Created,
        OrderEventTypeEnum.Assigned,
        OrderEventTypeEnum.StatusChanged,
        OrderEventTypeEnum.PhotoAdded,
        OrderEventTypeEnum.SyncConflict,
      ],
    }).notNull(),
    payload: jsonb('payload').notNull(),
    source: text('source', { enum: ['api', 'sync'] }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('order_events_order_id_idx').on(table.orderId),
    check(
      'order_events_type_check',
      sql`${table.type} in ('created', 'assigned', 'status_changed', 'photo_added', 'sync_conflict')`,
    ),
    check('order_events_source_check', sql`${table.source} in ('api', 'sync')`),
  ],
);

// История назначений: tombstone для pull (FR-08) — unassigned_seq из общей sync_seq.
export const orderAssignments = pgTable(
  'order_assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
    unassignedAt: timestamp('unassigned_at', { withTimezone: true }),
    unassignedSeq: bigint('unassigned_seq', { mode: 'number' }),
  },
  (table) => [
    index('order_assignments_order_id_idx').on(table.orderId),
    index('order_assignments_user_id_idx').on(table.userId),
    index('order_assignments_unassigned_seq_idx').on(table.unassignedSeq),
  ],
);
