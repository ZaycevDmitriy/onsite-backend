// Публичный API модуля auth: единственная точка импорта для соседей.
export { authRoutes, type IAuthRoutesOptions } from './routes.js';
export {
  createAuthService,
  type IAuthService,
  type IAuthServiceOptions,
  type ITokenPair,
} from './service.js';
