// Публичный API модуля users: единственная точка импорта для соседей.
export { UserRoleEnum } from './db-schema.js';
export { usersRoutes, type IUsersRoutesOptions } from './routes.js';
export { userViewSchema } from './schemas.js';
export {
  createUser,
  findAuthRecordByEmail,
  getActiveUser,
  getActiveUserForShare,
  hasAnyUsers,
  normalizeEmail,
  updateUser,
  type IActiveUser,
  type ICreateUserInput,
  type IUpdateUserInput,
  type IUpdateUserResult,
  type IUserAuthRecord,
  type IUserView,
} from './service.js';
