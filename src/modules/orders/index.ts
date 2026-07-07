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
  assignOrder,
  createOrder,
  findOrderForAccess,
  getOrder,
  listOrders,
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
  type ITransitionOrderInput,
  type IUpdateOrderInput,
} from './service.js';
