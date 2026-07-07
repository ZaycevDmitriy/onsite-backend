// Публичный API модуля sync: единственная точка импорта для соседей.
export { syncRoutes, type ISyncRoutesOptions } from './routes.js';
export {
  pullSync,
  type IGetCurrentSyncSeq,
  type IListCommittedPhotosByOrderIds,
  type IListOrdersForSync,
  type IListUnassignedTombstones,
  type IPullSyncDeps,
  type IPullSyncOptions,
  type IPullSyncResult,
  type ISyncOrderPayload,
  type ISyncPullItemView,
} from './service.js';
