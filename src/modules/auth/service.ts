import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { verify } from '@node-rs/argon2';

import { findAuthRecordByEmail, getActiveUser, normalizeEmail } from '@/modules/users/index.js';
import { AppError, ErrorCodeEnum } from '@/shared/errors/index.js';

import {
  findSessionByTokenHash,
  insertSession,
  revokeFamilySessions,
  revokeSessionById,
  revokeSessionsByUserId,
} from './repository.js';

import type { UserRoleEnum } from '@/modules/users/index.js';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { FastifyBaseLogger } from 'fastify';

// Ограничитель неудачных логинов: 5 подряд → блокировка на 15 минут (FR-01).
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

export interface ITokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface IAuthServiceOptions {
  db: NodePgDatabase;
  refreshTokenTtlSec: number;
  // Подпись access-токена инъецируется из composition root (app.jwt.sign).
  signAccessToken: (payload: { sub: string; role: UserRoleEnum }) => string;
}

export interface IAuthService {
  login: (email: string, password: string, logger: FastifyBaseLogger) => Promise<ITokenPair>;
  refresh: (refreshToken: string, logger: FastifyBaseLogger) => Promise<ITokenPair>;
  logout: (refreshToken: string, logger: FastifyBaseLogger) => Promise<void>;
  revokeAllUserSessions: (userId: string, logger: FastifyBaseLogger) => Promise<void>;
}

/** SHA-256-хеш refresh-токена: в БД сам токен не хранится. */
const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

/** Непрозрачный refresh-токен: 32 случайных байта в base64url. */
const generateRefreshToken = (): string => randomBytes(32).toString('base64url');

const invalidCredentialsError = (): AppError =>
  // Одинаковый ответ для неверного пароля и несуществующего email: аккаунты не раскрываются.
  new AppError(401, ErrorCodeEnum.InvalidCredentials, 'Invalid email or password');

const invalidRefreshError = (): AppError =>
  new AppError(401, ErrorCodeEnum.Unauthorized, 'Invalid refresh token');

/**
 * Фабрика сервиса auth. Состояние лимитера — per-instance:
 * параллельные buildApp в тестах не разделяют счётчики.
 * Ограничение: при 2+ инстансах приложения счётчик не разделяется (MVP, см. план).
 */
export const createAuthService = (options: IAuthServiceOptions): IAuthService => {
  const { db, refreshTokenTtlSec, signAccessToken } = options;
  const failedAttempts = new Map<string, { count: number; lockedUntil: number | null }>();

  const assertNotLocked = (email: string): void => {
    const state = failedAttempts.get(email);

    if (state?.lockedUntil !== null && state?.lockedUntil !== undefined) {
      if (state.lockedUntil > Date.now()) {
        throw new AppError(429, ErrorCodeEnum.TooManyAttempts, 'Too many failed login attempts');
      }
      // Срок блокировки истёк: счётчик начинается заново.
      failedAttempts.delete(email);
    }
  };

  const registerFailure = (email: string): void => {
    const state = failedAttempts.get(email) ?? { count: 0, lockedUntil: null };
    state.count += 1;

    if (state.count >= MAX_FAILED_ATTEMPTS) {
      state.lockedUntil = Date.now() + LOCKOUT_MS;
    }

    failedAttempts.set(email, state);
  };

  const issueTokenPair = async (
    userId: string,
    role: UserRoleEnum,
    familyId: string,
  ): Promise<ITokenPair> => {
    const refreshToken = generateRefreshToken();

    await insertSession(db, {
      userId,
      tokenHash: hashToken(refreshToken),
      familyId,
      expiresAt: new Date(Date.now() + refreshTokenTtlSec * 1000),
    });

    return { accessToken: signAccessToken({ sub: userId, role }), refreshToken };
  };

  return {
    async login(email, password, logger) {
      const normalized = normalizeEmail(email);
      logger.debug('попытка логина');

      assertNotLocked(normalized);

      const record = await findAuthRecordByEmail(db, normalized);
      // Неизвестный email проверяется тем же путём: ответ и тайминг не раскрывают аккаунт.
      const passwordValid =
        record !== null && record.isActive && (await verify(record.passwordHash, password));

      if (!passwordValid) {
        registerFailure(normalized);
        logger.debug('логин отклонён: неверные учётные данные');
        throw invalidCredentialsError();
      }

      failedAttempts.delete(normalized);
      const pair = await issueTokenPair(record.id, record.role, randomUUID());
      logger.info({ userId: record.id }, 'логин успешен, выпущена пара токенов');

      return pair;
    },

    async refresh(refreshToken, logger) {
      logger.debug('попытка ротации refresh-токена');
      const session = await findSessionByTokenHash(db, hashToken(refreshToken));

      if (session === null) {
        logger.debug('refresh-токен не найден');
        throw invalidRefreshError();
      }

      if (session.revokedAt !== null) {
        // Replay погашенного токена: отзывается вся семья (FR-02).
        await revokeFamilySessions(db, session.familyId);
        logger.warn({ familyId: session.familyId, userId: session.userId }, 'replay refresh-токена: семья отозвана');
        throw invalidRefreshError();
      }

      if (session.expiresAt.getTime() <= Date.now()) {
        logger.debug({ userId: session.userId }, 'refresh-токен просрочен');
        throw invalidRefreshError();
      }

      const activeUser = await getActiveUser(db, session.userId);

      if (activeUser === null) {
        await revokeFamilySessions(db, session.familyId);
        logger.debug({ userId: session.userId }, 'пользователь деактивирован: семья отозвана');
        throw invalidRefreshError();
      }

      // Ротация атомарно: отзыв старой и выпуск новой сессии в одной транзакции.
      const newRefreshToken = generateRefreshToken();
      await db.transaction(async (tx) => {
        await revokeSessionById(tx, session.id);
        await insertSession(tx, {
          userId: session.userId,
          tokenHash: hashToken(newRefreshToken),
          familyId: session.familyId,
          expiresAt: new Date(Date.now() + refreshTokenTtlSec * 1000),
        });
      });

      logger.info({ userId: session.userId }, 'refresh-токен ротирован');

      return {
        accessToken: signAccessToken({ sub: activeUser.id, role: activeUser.role }),
        refreshToken: newRefreshToken,
      };
    },

    async logout(refreshToken, logger) {
      const session = await findSessionByTokenHash(db, hashToken(refreshToken));

      // Logout идемпотентен: неизвестный токен не раскрывается ошибкой.
      if (session !== null) {
        await revokeFamilySessions(db, session.familyId);
        logger.info({ userId: session.userId }, 'logout: семья сессий отозвана');
      } else {
        logger.debug('logout с неизвестным токеном: no-op');
      }
    },

    async revokeAllUserSessions(userId, logger) {
      await revokeSessionsByUserId(db, userId);
      logger.info({ userId }, 'все refresh-сессии пользователя отозваны');
    },
  };
};
