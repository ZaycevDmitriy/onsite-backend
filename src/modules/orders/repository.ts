import { and, asc, desc, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';

import { orderAssignments, orderEvents, orders } from './db-schema.js';

import type { OrderEventTypeEnum } from './db-schema.js';
import type { ServiceOrderStatusEnum } from './domain.js';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

// Строки таблиц модуля orders как их видит Drizzle.
export type IOrderRow = typeof orders.$inferSelect;
export type IOrderEventRow = typeof orderEvents.$inferSelect;
export type IOrderAssignmentRow = typeof orderAssignments.$inferSelect;

// Транзакционный или обычный клиент Drizzle — assign/transition идут в транзакции с FOR UPDATE.
export type DbClient = NodePgDatabase | Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0];

export interface IInsertOrderInput {
  title: string;
  client: string;
  address: string;
  description: string;
  scheduledAt: Date;
  slotStart: Date;
  slotEnd: Date;
  latitude?: number;
  longitude?: number;
}

export interface IUpdateOrderPatch {
  title?: string;
  client?: string;
  address?: string;
  description?: string;
  scheduledAt?: Date;
  slotStart?: Date;
  slotEnd?: Date;
  latitude?: number | null;
  longitude?: number | null;
  status?: ServiceOrderStatusEnum;
  assignedTo?: string | null;
}

export interface IListOrdersFilters {
  status?: ServiceOrderStatusEnum;
  assignedTo?: string;
  cursor?: { createdAt: Date; id: string };
  limit: number;
}

export interface IListOrdersForSyncFilters {
  assignedTo: string;
  cursor: number;
  limit: number;
}

export interface IListUnassignedTombstonesFilters {
  userId: string;
  cursor: number;
  limit: number;
}

export interface IInsertOrderEventInput {
  orderId: string;
  actorId: string;
  type: OrderEventTypeEnum;
  payload: unknown;
  source: 'api' | 'sync';
}

export interface IInsertAssignmentInput {
  orderId: string;
  userId: string;
}

/** Вставляет новую заявку. */
export const insertOrder = async (db: DbClient, input: IInsertOrderInput): Promise<IOrderRow> => {
  const rows = await db.insert(orders).values(input).returning();

  // returning() по одной записи всегда отдаёт ровно одну строку.
  return rows[0] as IOrderRow;
};

/** Ищет заявку по id без блокировки строки. */
export const findOrderById = async (db: DbClient, id: string): Promise<IOrderRow | null> => {
  const rows = await db.select().from(orders).where(eq(orders.id, id)).limit(1);

  return rows[0] ?? null;
};

/**
 * Ищет заявку по id с блокировкой строки (SELECT ... FOR UPDATE).
 * Вызывать только внутри db.transaction — assign/transition сериализуют конкурентные правки заявки.
 */
export const findOrderByIdForUpdate = async (
  db: DbClient,
  id: string,
): Promise<IOrderRow | null> => {
  const rows = await db.select().from(orders).where(eq(orders.id, id)).for('update').limit(1);

  return rows[0] ?? null;
};

/**
 * Обновляет заявку и двигает курсор синка (updated_seq из sync_seq, решение #2).
 * null — если заявка не найдена.
 */
export const updateOrderById = async (
  db: DbClient,
  id: string,
  patch: IUpdateOrderPatch,
): Promise<IOrderRow | null> => {
  const rows = await db
    .update(orders)
    .set({ ...patch, updatedSeq: sql`nextval('sync_seq')`, updatedAt: new Date() })
    .where(eq(orders.id, id))
    .returning();

  return rows[0] ?? null;
};

/** Keyset-список заявок по (created_at DESC, id DESC) с фильтрами (решение #5). */
export const listOrders = async (
  db: DbClient,
  filters: IListOrdersFilters,
): Promise<IOrderRow[]> => {
  const conditions = [];

  if (filters.status !== undefined) {
    conditions.push(eq(orders.status, filters.status));
  }
  if (filters.assignedTo !== undefined) {
    conditions.push(eq(orders.assignedTo, filters.assignedTo));
  }
  if (filters.cursor !== undefined) {
    const { createdAt, id } = filters.cursor;
    conditions.push(
      or(lt(orders.createdAt, createdAt), and(eq(orders.createdAt, createdAt), lt(orders.id, id))),
    );
  }

  return db
    .select()
    .from(orders)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(orders.createdAt), desc(orders.id))
    .limit(filters.limit);
};

/**
 * Заявки техника, изменённые после курсора (pull-синхронизация, FR-08, решение #1 фазы 5).
 * Сортировка по updated_seq — курсор двигается по этому же полю.
 */
export const listOrdersForSync = async (
  db: DbClient,
  filters: IListOrdersForSyncFilters,
): Promise<IOrderRow[]> =>
  db
    .select()
    .from(orders)
    .where(and(eq(orders.assignedTo, filters.assignedTo), gt(orders.updatedSeq, filters.cursor)))
    .orderBy(asc(orders.updatedSeq))
    .limit(filters.limit);

/**
 * Tombstone-записи снятых/переназначенных назначений техника после курсора (FR-08, §5.5).
 * Сортировка по unassigned_seq — второй поток курсора pull, сливаемый с заявками по seq.
 */
export const listUnassignedTombstones = async (
  db: DbClient,
  filters: IListUnassignedTombstonesFilters,
): Promise<IOrderAssignmentRow[]> =>
  db
    .select()
    .from(orderAssignments)
    .where(
      and(
        eq(orderAssignments.userId, filters.userId),
        gt(orderAssignments.unassignedSeq, filters.cursor),
      ),
    )
    .orderBy(asc(orderAssignments.unassignedSeq))
    .limit(filters.limit);

/** Пишет событие в append-only журнал заявки (FR-15) — только insert, без update/delete. */
export const insertOrderEvent = async (
  db: DbClient,
  input: IInsertOrderEventInput,
): Promise<void> => {
  await db.insert(orderEvents).values(input);
};

/** Хронология событий заявки в порядке возникновения. */
export const findOrderEvents = async (db: DbClient, orderId: string): Promise<IOrderEventRow[]> =>
  db
    .select()
    .from(orderEvents)
    .where(eq(orderEvents.orderId, orderId))
    .orderBy(asc(orderEvents.id));

/** Ищет активное (неснятое) назначение заявки, если оно есть. */
export const findActiveAssignment = async (
  db: DbClient,
  orderId: string,
): Promise<IOrderAssignmentRow | null> => {
  const rows = await db
    .select()
    .from(orderAssignments)
    .where(and(eq(orderAssignments.orderId, orderId), isNull(orderAssignments.unassignedAt)))
    .limit(1);

  return rows[0] ?? null;
};

/** Создаёт новую запись в истории назначений. */
export const insertAssignment = async (
  db: DbClient,
  input: IInsertAssignmentInput,
): Promise<IOrderAssignmentRow> => {
  const rows = await db.insert(orderAssignments).values(input).returning();

  return rows[0] as IOrderAssignmentRow;
};

/** Закрывает назначение tombstone'ом: unassigned_at + unassigned_seq из sync_seq (§5.5). */
export const closeAssignment = async (db: DbClient, id: string): Promise<void> => {
  await db
    .update(orderAssignments)
    .set({ unassignedAt: new Date(), unassignedSeq: sql`nextval('sync_seq')` })
    .where(eq(orderAssignments.id, id));
};
