// Публичный API модуля sync: единственная точка импорта для соседей.
export { SyncMutationResultEnum } from './db-schema.js';
export { syncRoutes, type ISyncRoutesOptions } from './routes.js';
export {
  applyMutationBatch,
  pullSync,
  type IApplyMutationBatchDeps,
  type IApplySyncTransition,
  type ICommitStagedPhoto,
  type IFindStagedPhotoForCommit,
  type IGetCurrentSyncSeq,
  type IListCommittedPhotosByOrderIds,
  type IListOrdersForSync,
  type IListUnassignedTombstones,
  type IPhotoAddMutationInput,
  type IPullSyncDeps,
  type IPullSyncOptions,
  type IPullSyncResult,
  type IRecordSyncPhotoAdded,
  type IStatusChangeMutationInput,
  type ISyncMutationInput,
  type ISyncMutationVerdict,
  type ISyncOrderPayload,
  type ISyncPullItemView,
} from './service.js';
