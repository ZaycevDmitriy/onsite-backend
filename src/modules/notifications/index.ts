// Публичный API модуля notifications: единственная точка импорта для соседей.
export { PushOutboxStatusEnum, type IOutboxTicket } from './db-schema.js';
export { notificationsRoutes } from './routes.js';
export {
  registerDevice,
  type IDeviceRequester,
  type IRegisterDeviceInput,
} from './service.js';
