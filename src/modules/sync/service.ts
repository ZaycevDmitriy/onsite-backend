import { buildSyncPage } from './domain.js';

import type {
  IBuildSyncPageResult,
  ISyncOrderPullItem,
  ISyncPullItem,
  ISyncUnassignedPullItem,
} from './domain.js';
import type { IOrderView, IUnassignedTombstoneView } from '@/modules/orders/index.js';
import type { IPhotoView } from '@/modules/photos/index.js';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { FastifyBaseLogger } from 'fastify';

// Полезная нагрузка заявки в pull-элементе: заявка + её committed-фото (решение #2 фазы 5).
export interface ISyncOrderPayload extends IOrderView {
  photos: IPhotoView[];
}

export type ISyncPullItemView = ISyncPullItem<ISyncOrderPayload>;

// Функции orders/photos, инъецируемые composition root'ом (app.ts, паттерн listCommittedPhotos,
// решение #7 фазы 5) — sync не импортирует сервисы соседних модулей напрямую.
export type IListOrdersForSync = (
  db: NodePgDatabase,
  filters: { assignedTo: string; cursor: number; limit: number },
  logger: FastifyBaseLogger,
) => Promise<IOrderView[]>;

export type IListUnassignedTombstones = (
  db: NodePgDatabase,
  filters: { userId: string; cursor: number; limit: number },
  logger: FastifyBaseLogger,
) => Promise<IUnassignedTombstoneView[]>;

export type IGetCurrentSyncSeq = (db: NodePgDatabase) => Promise<number>;

export type IListCommittedPhotosByOrderIds = (
  db: NodePgDatabase,
  orderIds: string[],
) => Promise<Map<string, IPhotoView[]>>;

export interface IPullSyncDeps {
  listOrdersForSync: IListOrdersForSync;
  listUnassignedTombstones: IListUnassignedTombstones;
  getCurrentSyncSeq: IGetCurrentSyncSeq;
  listCommittedPhotosByOrderIds: IListCommittedPhotosByOrderIds;
}

export interface IPullSyncOptions {
  requesterId: string;
  cursor: number;
  limit: number;
  safetyLag: number;
}

export type IPullSyncResult = IBuildSyncPageResult<ISyncOrderPayload>;

/**
 * Собирает страницу pull-синхронизации техника (FR-08, T-10): заявки и tombstone читаются
 * с LIMIT limit+1 каждый, committed-фото — батчем без N+1, слияние и курсор — чистый домен sync.
 */
export const pullSync = async (
  db: NodePgDatabase,
  options: IPullSyncOptions,
  deps: IPullSyncDeps,
  logger: FastifyBaseLogger,
): Promise<IPullSyncResult> => {
  logger.debug(
    { requesterId: options.requesterId, cursor: options.cursor, limit: options.limit },
    'sync pull: старт',
  );

  const fetchLimit = options.limit + 1;

  const [orderRows, tombstoneRows, currentMaxSeq] = await Promise.all([
    deps.listOrdersForSync(
      db,
      { assignedTo: options.requesterId, cursor: options.cursor, limit: fetchLimit },
      logger,
    ),
    deps.listUnassignedTombstones(
      db,
      { userId: options.requesterId, cursor: options.cursor, limit: fetchLimit },
      logger,
    ),
    deps.getCurrentSyncSeq(db),
  ]);

  logger.debug(
    { orders: orderRows.length, tombstones: tombstoneRows.length, currentMaxSeq },
    'sync pull: сырые потоки получены',
  );

  const photosByOrderId = await deps.listCommittedPhotosByOrderIds(
    db,
    orderRows.map((row) => row.id),
  );

  const orderItems: ISyncOrderPullItem<ISyncOrderPayload>[] = orderRows.map((row) => ({
    type: 'order',
    seq: row.updatedSeq,
    order: { ...row, photos: photosByOrderId.get(row.id) ?? [] },
  }));

  const tombstoneItems: ISyncUnassignedPullItem[] = tombstoneRows.map((row) => ({
    type: 'unassigned',
    seq: row.seq,
    orderId: row.orderId,
  }));

  const page = buildSyncPage({
    orderItems,
    tombstoneItems,
    limit: options.limit,
    cursor: options.cursor,
    currentMaxSeq,
    safetyLag: options.safetyLag,
  });

  logger.info(
    { count: page.items.length, nextCursor: page.nextCursor },
    'sync pull: страница собрана',
  );

  return page;
};
