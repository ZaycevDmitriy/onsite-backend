import { getActiveUserForShare, UserRoleEnum } from '@/modules/users/index.js';
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
  listOrdersForSync as listOrdersForSyncRepo,
  listUnassignedTombstones as listUnassignedTombstonesRepo,
  updateOrderById,
} from './repository.js';

import type {
  DbClient,
  IInsertOrderInput,
  IListOrdersFilters,
  IListOrdersForSyncFilters,
  IListUnassignedTombstonesFilters,
  IOrderAssignmentRow,
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

// Фото в детальном ответе заявки: контракт принадлежит orders, структурно совпадает с
// photos/IPhotoView, но без импорта из photos — иначе ESM-цикл photos ↔ orders (решение #16).
export interface IOrderPhotoView {
  id: string;
  orderId: string;
  authorId: string;
  status: 'staged' | 'committed';
  comment: string | null;
  takenAt: string;
  createdAt: string;
}

// Листер committed-фото заявки: инъецируется composition root'ом из @/modules/photos (решение #10).
export type IListCommittedPhotos = (
  db: NodePgDatabase,
  orderId: string,
) => Promise<IOrderPhotoView[]>;

// Ответ GET /v1/orders/:id: заявка + фото + события (решение #4, #10).
export interface IOrderDetailView extends IOrderView {
  photos: IOrderPhotoView[];
  events: IOrderEventView[];
}

// Лёгкая проекция заявки для проверки доступа соседними модулями (photos, решение #15 фазы 4).
export interface IOrderAccessInfo {
  id: string;
  assignedTo: string | null;
  status: ServiceOrderStatusEnum;
}

// Tombstone-элемент pull-синхронизации: снятое/переназначенное назначение техника (решение #2 фазы 5).
export interface IUnassignedTombstoneView {
  orderId: string;
  seq: number;
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
  // null снимает координату.
  latitude?: number | null;
  longitude?: number | null;
}

export interface IAssignOrderInput {
  technicianId: string;
}

export interface ITransitionOrderInput {
  to: ServiceOrderStatusEnum;
  baseStatus: ServiceOrderStatusEnum;
}

// Вердикт синк-перехода (решение #5, #7 фазы 5): результат вместо исключения — sync сам решает,
// как отразить его в ответе батча мутаций.
export type ISyncTransitionResult =
  | { result: 'rejected'; code: 'not_found' }
  | { result: 'conflict'; order: IOrderView }
  | { result: 'applied'; order: IOrderView };

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
  listCommittedPhotos: IListCommittedPhotos,
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

  const [photos, events] = await Promise.all([
    listCommittedPhotos(db, id),
    findOrderEvents(db, id),
  ]);

  logger.info({ orderId: id }, 'заявка получена');

  return { ...toOrderView(row), photos, events: events.map(toOrderEventView) };
};

/**
 * Лёгкая выборка заявки для проверки доступа соседним модулем (photos): id, assignedTo, status,
 * без событий — getOrder не подходит инъекции листера фото из-за цикла (решение #15 фазы 4).
 */
export const findOrderForAccess = async (
  db: NodePgDatabase,
  id: string,
): Promise<IOrderAccessInfo | null> => {
  const row = await findOrderById(db, id);

  if (row === null) {
    return null;
  }

  return { id: row.id, assignedTo: row.assignedTo, status: row.status };
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

/**
 * Заявки техника, изменённые после курсора (pull-синхронизация, FR-08, зависимость sync).
 * Выборка limit+1 — расчёт hasMore/nextCursor остаётся на стороне вызывающего sync-сервиса.
 */
export const listOrdersForSync = async (
  db: NodePgDatabase,
  filters: IListOrdersForSyncFilters,
  logger: FastifyBaseLogger,
): Promise<IOrderView[]> => {
  logger.debug({ assignedTo: filters.assignedTo, cursor: filters.cursor }, 'sync: список заявок по курсору');

  const rows = await listOrdersForSyncRepo(db, filters);

  logger.debug({ count: rows.length }, 'sync: заявки по курсору получены');

  return rows.map(toOrderView);
};

const toTombstoneView = (row: IOrderAssignmentRow): IUnassignedTombstoneView => ({
  orderId: row.orderId,
  // unassignedSeq не может быть null — выборка уже отфильтрована по gt(cursor) в репозитории.
  seq: row.unassignedSeq as number,
});

/** Tombstone снятых/переназначенных назначений техника после курсора (pull-синхронизация, FR-08). */
export const listUnassignedTombstones = async (
  db: NodePgDatabase,
  filters: IListUnassignedTombstonesFilters,
  logger: FastifyBaseLogger,
): Promise<IUnassignedTombstoneView[]> => {
  logger.debug({ userId: filters.userId, cursor: filters.cursor }, 'sync: список tombstone по курсору');

  const rows = await listUnassignedTombstonesRepo(db, filters);

  logger.debug({ count: rows.length }, 'sync: tombstone по курсору получены');

  return rows.map(toTombstoneView);
};

/** Снимок заявки для вердиктов синка (конфликт/применённая мутация, решение #5-6 фазы 5). */
export const getOrderSnapshot = async (db: DbClient, id: string): Promise<IOrderView | null> => {
  const row = await findOrderById(db, id);

  return row === null ? null : toOrderView(row);
};

/**
 * Синк-версия перехода статуса (FR-09/FR-10, source='sync'): вызывается внутри транзакции
 * мутации sync (принимает tx как DbClient) — не бросает AppError, возвращает вердикт с
 * решением, чтобы sync мог зафиксировать его в sync_mutations байт-в-байт (решение #3, #5).
 */
export const applySyncTransition = async (
  db: DbClient,
  id: string,
  input: ITransitionOrderInput,
  requester: IOrderRequester,
  logger: FastifyBaseLogger,
): Promise<ISyncTransitionResult> => {
  logger.debug({ orderId: id, to: input.to }, 'sync: переход статуса заявки');

  const current = await findOrderByIdForUpdate(db, id);

  if (current === null) {
    logger.debug({ orderId: id }, 'sync: переход отклонён — заявка не найдена');

    return { result: 'rejected', code: 'not_found' };
  }

  if (current.assignedTo !== requester.id) {
    logger.debug(
      { orderId: id, assignedTo: current.assignedTo, requesterId: requester.id },
      'sync: переход отклонён — заявка не назначена на техника',
    );

    return { result: 'conflict', order: toOrderView(current) };
  }

  if (current.status !== input.baseStatus || !canTransition(current.status, input.to)) {
    logger.debug(
      { orderId: id, baseStatus: input.baseStatus, actualStatus: current.status, to: input.to },
      'sync: переход отклонён — конфликт статуса',
    );

    await insertOrderEvent(db, {
      orderId: id,
      actorId: requester.id,
      type: OrderEventTypeEnum.SyncConflict,
      payload: { baseStatus: input.baseStatus, to: input.to, actualStatus: current.status },
      source: 'sync',
    });

    return { result: 'conflict', order: toOrderView(current) };
  }

  await insertOrderEvent(db, {
    orderId: id,
    actorId: requester.id,
    type: OrderEventTypeEnum.StatusChanged,
    payload: { from: current.status, to: input.to, occurredAt: new Date().toISOString() },
    source: 'sync',
  });

  const updated = await updateOrderById(db, id, { status: input.to });

  logger.info({ orderId: id, status: input.to }, 'sync: переход статуса применён');

  // Строка только что найдена FOR UPDATE в этой же транзакции: не может отсутствовать.
  return { result: 'applied', order: toOrderView(updated as IOrderRow) };
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

  const row = await db.transaction(async (tx) => {
    const current = await findOrderByIdForUpdate(tx, id);

    if (current === null) {
      throw new AppError(404, ErrorCodeEnum.NotFound, 'Order not found');
    }

    // FOR SHARE на строке пользователя: конкурентная деактивация ждёт коммита назначения (без TOCTOU).
    const technician = await getActiveUserForShare(tx, input.technicianId);

    if (technician === null || technician.role !== UserRoleEnum.Technician) {
      logger.debug(
        { technicianId: input.technicianId },
        'назначение отклонено: техник не найден или неактивен',
      );
      throw new AppError(422, ErrorCodeEnum.ValidationFailed, 'Technician not found or inactive');
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
