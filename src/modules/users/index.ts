// Публичный API модуля users: единственная точка импорта для соседей.
export { UserRoleEnum } from './db-schema.js';
export {
  createUser,
  findAuthRecordByEmail,
  getActiveUser,
  normalizeEmail,
  updateUser,
  type IActiveUser,
  type ICreateUserInput,
  type IUpdateUserInput,
  type IUpdateUserResult,
  type IUserAuthRecord,
  type IUserView,
} from './service.js';
