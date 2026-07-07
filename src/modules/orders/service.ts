import { getActiveUser, UserRoleEnum } from '@/modules/users/index.js';
import { AppError, ErrorCodeEnum } from '@/shared/errors/index.js';

import { OrderEventTypeEnum } from './db-schema.js';
import { ServiceOrderStatusEnum, canAssign, canTransition } from './domain.js';
import {
  closeAssignment,
  findActiveAssignment,
  findOrderById,
  findOrderByIdForUpdate,
  findOrderEvents,
  insertAssignment,
  insertOrder,
  insertOrderEvent,
  listOrders as listOrdersRepo,
  updateOrderById,
} from './repository.js';

import type {
  IInsertOrderInput,
  IListOrdersFilters,
  IOrderEventRow,
  IOrderRow,
  IUpdateOrderPatch,
} from './repository.js';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { FastifyBaseLogger } from 'fastify';

// Заявитель операции: id + роль из request.user (authPlugin).
export interface IOrderRequester {
  id: string;
  role: UserRoleEnum;
}

// Представление заявки для API: даты — ISO 8601 UTC.
export interface IOrderView {
  id: string;
  status: ServiceOrderStatusEnum;
  title: string;
  client: string;
  address: string;
  description: string;
  scheduledAt: string;
  slotStart: string;
  slotEnd: string;
  latitude: number | null;
  longitude: number | null;
  assignedTo: string | null;
  updatedSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface IOrderEventView {
  id: number;
  actorId: string;
  type: OrderEventTypeEnum;
  payload: unknown;
  source: 'api' | 'sync';
  createdAt: string;
}

// Ответ GET /v1/orders/:id: заявка + фото (пусто до фазы 4) + события (решение #4).
export interface IOrderDetailView extends IOrderView {
  photos: unknown[];
  events: IOrderEventView[];
}

export interface ICreateOrderInput {
  title: string;
  client: string;
  address: string;
  description: string;
  scheduledAt: string;
  slotStart: string;
  slotEnd: string;
  latitude?: number;
  longitude?: number;
}

export interface IUpdateOrderInput {
  title?: string;
  client?: string;
  address?: string;
  description?: string;
  scheduledAt?: string;
  slotStart?: string;
  slotEnd?: string;
  latitude?: number;
  longitude?: number;
}

export interface IAssignOrderInput {
  technicianId: string;
}

export interface ITransitionOrderInput {
  to: ServiceOrderStatusEnum;
  baseStatus: ServiceOrderStatusEnum;
}

export interface IListOrdersQuery {
  status?: ServiceOrderStatusEnum;
  assignedTo?: string;
  cursor?: string;
  limit?: number;
}

export interface IListOrdersResult {
  items: IOrderView[];
  nextCursor: string | null;
}

// Дефолтный размер страницы списка заявок (решение #5).
const DEFAULT_LIST_LIMIT = 50;

const toOrderView = (row: IOrderRow): IOrderView => ({
  id: row.id,
  status: row.status,
  title: row.title,
  client: row.client,
  address: row.address,
  description: row.description,
  scheduledAt: row.scheduledAt.toISOString(),
  slotStart: row.slotStart.toISOString(),
  slotEnd: row.slotEnd.toISOString(),
  latitude: row.latitude,
  longitude: row.longitude,
  assignedTo: row.assignedTo,
  updatedSeq: row.updatedSeq,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const toOrderEventView = (row: IOrderEventRow): IOrderEventView => ({
  id: row.id,
  actorId: row.actorId,
  type: row.type,
  payload: row.payload,
  source: row.source,
  createdAt: row.createdAt.toISOString(),
});

interface IOrderCursor {
  createdAt: string;
  id: string;
}

/** Кодирует курсор списка: непрозрачная base64url-пара (created_at, id) (решение #5). */
const encodeCursor = (row: Pick<IOrderRow, 'createdAt' | 'id'>): string =>
  Buffer.from(
    JSON.stringify({ createdAt: row.createdAt.toISOString(), id: row.id } satisfies IOrderCursor),
    'utf8',
  ).toString('base64url');

/** Декодирует курсор списка; невалидный курсор → 422 validation_failed. */
const decodeCursor = (cursor: string): { createdAt: Date; id: string } => {
  const invalidCursorError = (): AppError =>
    new AppError(422, ErrorCodeEnum.ValidationFailed, 'Invalid cursor');

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursorError();
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as Partial<IOrderCursor>).createdAt !== 'string' ||
    typeof (parsed as Partial<IOrderCursor>).id !== 'string'
  ) {
    throw invalidCursorError();
  }

  const { createdAt, id } = parsed as IOrderCursor;
  const createdAtDate = new Date(createdAt);

  if (Number.isNaN(createdAtDate.getTime())) {
    throw invalidCursorError();
  }

  return { createdAt: createdAtDate, id };
};

/** Создаёт заявку и пишет событие `created` в одной транзакции (dispatcher, FR-05). */
export const createOrder = async (
  db: NodePgDatabase,
  input: ICreateOrderInput,
  requester: IOrderRequester,
  logger: FastifyBaseLogger,
): Promise<IOrderView> => {
  logger.debug({ title: input.title }, 'создание заявки');

  const insertInput: IInsertOrderInput = {
    title: input.title,
    client: input.client,
    address: input.address,
    description: input.description,
    scheduledAt: new Date(input.scheduledAt),
    slotStart: new Date(input.slotStart),
    slotEnd: new Date(input.slotEnd),
    ...(input.latitude !== undefined ? { latitude: input.latitude } : {}),
    ...(input.longitude !== undefined ? { longitude: input.longitude } : {}),
  };

  const row = await db.transaction(async (tx) => {
    const inserted = await insertOrder(tx, insertInput);

    await insertOrderEvent(tx, {
      orderId: inserted.id,
      actorId: requester.id,
      type: OrderEventTypeEnum.Created,
      payload: {},
      source: 'api',
    });

    return inserted;
  });

  logger.info({ orderId: row.id }, 'заявка создана');

  return toOrderView(row);
};

/** Возвращает заявку с фото и событиями; чужая заявка техника → 404, не 403 (FR-03). */
export const getOrder = async (
  db: NodePgDatabase,
  id: string,
  requester: IOrderRequester,
  logger: FastifyBaseLogger,
): Promise<IOrderDetailView> => {
  logger.debug({ orderId: id }, 'получение заявки');

  const row = await findOrderById(db, id);

  if (
    row === null ||
    (requester.role === UserRoleEnum.Technician && row.assignedTo !== requester.id)
  ) {
    logger.debug({ orderId: id }, 'заявка не найдена или не принадлежит технику');
    throw new AppError(404, ErrorCodeEnum.NotFound, 'Order not found');
  }

  const events = await findOrderEvents(db, id);

  logger.info({ orderId: id }, 'заявка получена');

  return { ...toOrderView(row), photos: [], events: events.map(toOrderEventView) };
};

/**
 * Список заявок: dispatcher — все (+фильтры), technician — только свои (решение #9, FR-03).
 * Keyset-пагинация по (created_at DESC, id DESC), выборка limit+1 для расчёта nextCursor.
 */
export const listOrders = async (
  db: NodePgDatabase,
  query: IListOrdersQuery,
  requester: IOrderRequester,
  logger: FastifyBaseLogger,
): Promise<IListOrdersResult> => {
  const limit = query.limit ?? DEFAULT_LIST_LIMIT;
  const assignedTo = requester.role === UserRoleEnum.Technician ? requester.id : query.assignedTo;

  logger.debug({ status: query.status, assignedTo, limit }, 'список заявок');

  const cursor = query.cursor !== undefined ? decodeCursor(query.cursor) : undefined;

  const filters: IListOrdersFilters = {
    limit: limit + 1,
    ...(query.status !== undefined ? { status: query.status } : {}),
    ...(assignedTo !== undefined ? { assignedTo } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
  };

  const rows = await listOrdersRepo(db, filters);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const lastRow = page[page.length - 1];
  const nextCursor = hasMore && lastRow !== undefined ? encodeCursor(lastRow) : null;

  logger.info({ count: page.length, hasMore }, 'список заявок получен');

  return { items: page.map(toOrderView), nextCursor };
};

/** Правит поля заявки (dispatcher); статус — только через transition; Done/Cancelled → 409. */
export const updateOrder = async (
  db: NodePgDatabase,
  id: string,
  input: IUpdateOrderInput,
  logger: FastifyBaseLogger,
): Promise<IOrderView> => {
  logger.debug({ orderId: id }, 'правка заявки');

  const row = await db.transaction(async (tx) => {
    const current = await findOrderByIdForUpdate(tx, id);

    if (current === null) {
      throw new AppError(404, ErrorCodeEnum.NotFound, 'Order not found');
    }

    if (
      current.status === ServiceOrderStatusEnum.Done ||
      current.status === ServiceOrderStatusEnum.Cancelled
    ) {
      logger.debug({ orderId: id, status: current.status }, 'правка отклонена: заявка завершена');
      throw new AppError(409, ErrorCodeEnum.Conflict, 'Order is already finished', {
        status: current.status,
      });
    }

    const patch: IUpdateOrderPatch = {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.client !== undefined ? { client: input.client } : {}),
      ...(input.address !== undefined ? { address: input.address } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.scheduledAt !== undefined ? { scheduledAt: new Date(input.scheduledAt) } : {}),
      ...(input.slotStart !== undefined ? { slotStart: new Date(input.slotStart) } : {}),
      ...(input.slotEnd !== undefined ? { slotEnd: new Date(input.slotEnd) } : {}),
      ...(input.latitude !== undefined ? { latitude: input.latitude } : {}),
      ...(input.longitude !== undefined ? { longitude: input.longitude } : {}),
    };

    const updated = await updateOrderById(tx, id, patch);

    // Строка только что найдена FOR UPDATE в этой же транзакции: не может отсутствовать.
    return updated as IOrderRow;
  });

  logger.info({ orderId: id }, 'заявка обновлена');

  return toOrderView(row);
};

/**
 * Назначает/переназначает техника (dispatcher, FR-06).
 * Несуществующий/неактивный/не-technician → 422; статус вне New/InProgress → 409;
 * повторное назначение того же техника — идемпотентный no-op без дублей в истории (решение #7).
 */
export const assignOrder = async (
  db: NodePgDatabase,
  id: string,
  input: IAssignOrderInput,
  requester: IOrderRequester,
  logger: FastifyBaseLogger,
): Promise<IOrderView> => {
  logger.debug({ orderId: id, technicianId: input.technicianId }, 'назначение заявки');

  const technician = await getActiveUser(db, input.technicianId);

  if (technician === null || technician.role !== UserRoleEnum.Technician) {
    logger.debug(
      { technicianId: input.technicianId },
      'назначение отклонено: техник не найден или неактивен',
    );
    throw new AppError(422, ErrorCodeEnum.ValidationFailed, 'Technician not found or inactive');
  }

  const row = await db.transaction(async (tx) => {
    const current = await findOrderByIdForUpdate(tx, id);

    if (current === null) {
      throw new AppError(404, ErrorCodeEnum.NotFound, 'Order not found');
    }

    if (!canAssign(current.status)) {
      logger.debug(
        { orderId: id, status: current.status },
        'назначение отклонено: недопустимый статус',
      );
      throw new AppError(409, ErrorCodeEnum.Conflict, 'Order is not assignable', {
        status: current.status,
      });
    }

    const active = await findActiveAssignment(tx, id);

    if (active !== null && active.userId === input.technicianId) {
      logger.debug(
        { orderId: id, technicianId: input.technicianId },
        'назначение уже действует: идемпотентный no-op',
      );
      return current;
    }

    if (active !== null) {
      await closeAssignment(tx, active.id);
    }

    await insertAssignment(tx, { orderId: id, userId: input.technicianId });

    await insertOrderEvent(tx, {
      orderId: id,
      actorId: requester.id,
      type: OrderEventTypeEnum.Assigned,
      payload: { technicianId: input.technicianId },
      source: 'api',
    });

    const updated = await updateOrderById(tx, id, { assignedTo: input.technicianId });

    // Строка только что найдена FOR UPDATE в этой же транзакции: не может отсутствовать.
    return updated as IOrderRow;
  });

  logger.info({ orderId: id, technicianId: input.technicianId }, 'заявка назначена');

  return toOrderView(row);
};

/**
 * Переход статуса (FR-07): technician — только своя заявка (иначе 404), dispatcher — любая.
 * baseStatus не совпадает с текущим → 409 conflict со снимком; недопустимый переход → 409 invalid_transition.
 */
export const transitionOrder = async (
  db: NodePgDatabase,
  id: string,
  input: ITransitionOrderInput,
  requester: IOrderRequester,
  logger: FastifyBaseLogger,
): Promise<IOrderView> => {
  logger.debug({ orderId: id, to: input.to }, 'переход статуса заявки');

  const row = await db.transaction(async (tx) => {
    const current = await findOrderByIdForUpdate(tx, id);

    if (
      current === null ||
      (requester.role === UserRoleEnum.Technician && current.assignedTo !== requester.id)
    ) {
      logger.debug(
        { orderId: id },
        'переход отклонён: заявка не найдена или не принадлежит технику',
      );
      throw new AppError(404, ErrorCodeEnum.NotFound, 'Order not found');
    }

    if (current.status !== input.baseStatus) {
      logger.debug(
        { orderId: id, baseStatus: input.baseStatus, actualStatus: current.status },
        'переход отклонён: несовпадение baseStatus',
      );
      throw new AppError(409, ErrorCodeEnum.Conflict, 'Order status has changed', {
        status: current.status,
      });
    }

    if (!canTransition(current.status, input.to)) {
      logger.debug(
        { orderId: id, from: current.status, to: input.to },
        'переход отклонён: недопустимый переход',
      );
      throw new AppError(409, ErrorCodeEnum.InvalidTransition, 'Invalid status transition', {
        status: current.status,
      });
    }

    await insertOrderEvent(tx, {
      orderId: id,
      actorId: requester.id,
      type: OrderEventTypeEnum.StatusChanged,
      payload: { from: current.status, to: input.to },
      source: 'api',
    });

    const updated = await updateOrderById(tx, id, { status: input.to });

    // Строка только что найдена FOR UPDATE в этой же транзакции: не может отсутствовать.
    return updated as IOrderRow;
  });

  logger.info({ orderId: id, status: input.to }, 'переход статуса применён');

  return toOrderView(row);
};
