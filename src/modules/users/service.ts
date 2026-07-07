import { hash } from '@node-rs/argon2';

import { AppError, ErrorCodeEnum } from '@/shared/errors/index.js';

import {
  findUserByEmail,
  findUserById,
  findUserByIdForShare,
  insertUser,
  updateUserById,
  type DbClient,
  type IUserRow,
} from './repository.js';

import type { UserRoleEnum } from './db-schema.js';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { FastifyBaseLogger } from 'fastify';

// Представление пользователя для API: без passwordHash, даты — ISO 8601 UTC.
export interface IUserView {
  id: string;
  email: string;
  role: UserRoleEnum;
  displayName: string;
  isActive: boolean;
  createdAt: string;
}

// Запись для логина: единственное место, где passwordHash покидает модуль.
export interface IUserAuthRecord {
  id: string;
  role: UserRoleEnum;
  isActive: boolean;
  passwordHash: string;
}

// Активный пользователь для auth-guard'а (инъецируется в authPlugin).
export interface IActiveUser {
  id: string;
  role: UserRoleEnum;
}

export interface ICreateUserInput {
  email: string;
  password: string;
  role: UserRoleEnum;
  displayName: string;
}

export interface IUpdateUserInput {
  displayName?: string;
  isActive?: boolean;
  password?: string;
}

export interface IUpdateUserResult {
  user: IUserView;
  // true — пароль сброшен, вызывающий обязан отозвать refresh-сессии.
  passwordChanged: boolean;
}

/** Нормализует email: трим и нижний регистр. */
export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

// Код unique-констрейнта PostgreSQL.
const PG_UNIQUE_VIOLATION = '23505';

/** Проверяет, что ошибка (или её cause) — нарушение unique-констрейнта PostgreSQL. */
const isUniqueViolation = (error: unknown): boolean => {
  for (let current = error; current instanceof Error; current = current.cause) {
    if ((current as { code?: unknown }).code === PG_UNIQUE_VIOLATION) {
      return true;
    }
  }

  return false;
};

const toUserView = (row: IUserRow): IUserView => ({
  id: row.id,
  email: row.email,
  role: row.role,
  displayName: row.displayName,
  isActive: row.isActive,
  createdAt: row.createdAt.toISOString(),
});

/** Возвращает активного пользователя по id или null (guard деактивации, FR-04). */
export const getActiveUser = async (
  db: NodePgDatabase,
  userId: string,
): Promise<IActiveUser | null> => {
  const row = await findUserById(db, userId);

  if (row === null || !row.isActive) {
    return null;
  }

  return { id: row.id, role: row.role };
};

/**
 * Возвращает активного пользователя с блокировкой строки FOR SHARE.
 * Вызывать внутри транзакции соседа: конкурентная деактивация ждёт её коммита (без TOCTOU).
 */
export const getActiveUserForShare = async (
  db: DbClient,
  userId: string,
): Promise<IActiveUser | null> => {
  const row = await findUserByIdForShare(db, userId);

  if (row === null || !row.isActive) {
    return null;
  }

  return { id: row.id, role: row.role };
};

/** Возвращает данные для проверки пароля при логине или null. */
export const findAuthRecordByEmail = async (
  db: NodePgDatabase,
  email: string,
): Promise<IUserAuthRecord | null> => {
  const row = await findUserByEmail(db, normalizeEmail(email));

  if (row === null) {
    return null;
  }

  return { id: row.id, role: row.role, isActive: row.isActive, passwordHash: row.passwordHash };
};

/** Создаёт пользователя: занятый email → 409 email_taken. */
export const createUser = async (
  db: NodePgDatabase,
  input: ICreateUserInput,
  logger: FastifyBaseLogger,
): Promise<IUserView> => {
  const email = normalizeEmail(input.email);
  logger.debug({ role: input.role }, 'создание пользователя');

  const existing = await findUserByEmail(db, email);

  if (existing !== null) {
    logger.debug('email уже занят');
    throw new AppError(409, ErrorCodeEnum.EmailTaken, 'Email is already taken');
  }

  const passwordHash = await hash(input.password);

  let row: IUserRow;
  try {
    row = await insertUser(db, {
      email,
      passwordHash,
      role: input.role,
      displayName: input.displayName,
    });
  } catch (error) {
    // Конкурентное создание с тем же email: unique-констрейнт БД → 409, не 500.
    if (isUniqueViolation(error)) {
      logger.debug('email занят (unique-констрейнт при конкурентной вставке)');
      throw new AppError(409, ErrorCodeEnum.EmailTaken, 'Email is already taken');
    }
    throw error;
  }

  logger.info({ userId: row.id, role: row.role }, 'пользователь создан');

  return toUserView(row);
};

/**
 * Обновляет пользователя: displayName, isActive, сброс пароля. Не найден → 404.
 * Самодеактивация диспетчера (isActive=false для собственного actorId) → 422 (guard ревью фазы 2).
 */
export const updateUser = async (
  db: NodePgDatabase,
  id: string,
  input: IUpdateUserInput,
  actorId: string,
  logger: FastifyBaseLogger,
): Promise<IUpdateUserResult> => {
  logger.debug({ userId: id }, 'обновление пользователя');

  if (input.isActive === false && id === actorId) {
    logger.debug({ userId: id }, 'самодеактивация отклонена');
    throw new AppError(422, ErrorCodeEnum.ValidationFailed, 'Cannot deactivate your own account');
  }

  const patch: { displayName?: string; isActive?: boolean; passwordHash?: string } = {};

  if (input.displayName !== undefined) {
    patch.displayName = input.displayName;
  }
  if (input.isActive !== undefined) {
    patch.isActive = input.isActive;
  }
  if (input.password !== undefined) {
    patch.passwordHash = await hash(input.password);
  }

  const row =
    Object.keys(patch).length === 0
      ? await findUserById(db, id)
      : await updateUserById(db, id, patch);

  if (row === null) {
    throw new AppError(404, ErrorCodeEnum.NotFound, 'User not found');
  }

  const passwordChanged = input.password !== undefined;
  logger.info({ userId: id, passwordChanged, isActive: row.isActive }, 'пользователь обновлён');

  return { user: toUserView(row), passwordChanged };
};
