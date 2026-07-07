// Публичный API модуля orders: единственная точка импорта для соседей (например, будущего sync).
export { OrderEventTypeEnum } from './db-schema.js';
export {
  ASSIGNABLE_STATUSES,
  ORDER_TRANSITIONS,
  ServiceOrderStatusEnum,
  canAssign,
  canTransition,
} from './domain.js';
export { ordersRoutes, type IOrdersRoutesOptions } from './routes.js';
export {
  applySyncTransition,
  assignOrder,
  createOrder,
  findOrderForAccess,
  getOrder,
  getOrderSnapshot,
  listOrders,
  listOrdersForSync,
  listUnassignedTombstones,
  recordSyncPhotoAdded,
  transitionOrder,
  updateOrder,
  type IAssignOrderInput,
  type ICreateOrderInput,
  type IListCommittedPhotos,
  type IListOrdersQuery,
  type IListOrdersResult,
  type IOrderAccessInfo,
  type IOrderDetailView,
  type IOrderEventView,
  type IOrderPhotoView,
  type IOrderRequester,
  type IOrderView,
  type ISyncTransitionResult,
  type ITransitionOrderInput,
  type IUnassignedTombstoneView,
  type IUpdateOrderInput,
} from './service.js';
export { getCurrentSyncSeq } from './repository.js';
export type {
  IListOrdersForSyncFilters,
  IListUnassignedTombstonesFilters,
} from './repository.js';
