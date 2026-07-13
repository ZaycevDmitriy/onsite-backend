import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { verify } from '@node-rs/argon2';

import { findAuthRecordByEmail, getActiveUser, normalizeEmail } from '@/modules/users/index.js';
import { AppError, ErrorCodeEnum } from '@/shared/errors/index.js';

import {
  deleteExpiredSessions,
  findSessionByTokenHash,
  insertSession,
  revokeFamilySessions,
  revokeSessionById,
  revokeSessionsByUserId,
} from './repository.js';

import type { IUserView, UserRoleEnum } from '@/modules/users/index.js';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { FastifyBaseLogger } from 'fastify';

// Ограничитель неудачных логинов: 5 подряд → блокировка на 15 минут (FR-01).
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
// Запись без новых неудач устаревает через окно блокировки: Map не растёт неограниченно
// при переборе случайных email (memory-DoS).
const FAILURE_TTL_MS = LOCKOUT_MS;
// Порог размера Map, при превышении которого перед вставкой выметаются устаревшие записи.
const FAILED_ATTEMPTS_SWEEP_THRESHOLD = 1000;
// Минимальный интервал между sweep'ами: полный проход по Map не чаще раза в 30 секунд,
// иначе поток уникальных email выше порога даёт O(n) на каждую вставку (CPU-DoS).
const SWEEP_MIN_INTERVAL_MS = 30 * 1000;

// Размер пачки за один DELETE зачистки просроченных сессий (как photos/service.ts).
const CLEANUP_BATCH_LIMIT = 100;

// Фиктивный argon2id-хеш случайного пароля: выравнивает тайминг ответа
// для несуществующего email — verify выполняется всегда (защита от enumeration).
const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$t2dAs7Zp8J1GSMU6CjAdeA$N2/NdYDKrHqnfNjmjtDa4nKhc/D0giytOmwVZSxmq6o';

export interface ITokenPair {
  accessToken: string;
  refreshToken: string;
}

// Ответ логина: пара токенов + профиль пользователя (§5.6 спеки).
export interface ILoginResult extends ITokenPair {
  user: IUserView;
}

export interface IAuthServiceOptions {
  db: NodePgDatabase;
  refreshTokenTtlSec: number;
  // Подпись access-токена инъецируется из composition root (app.jwt.sign).
  signAccessToken: (payload: { sub: string; role: UserRoleEnum }) => string;
}

export interface IAuthService {
  login: (email: string, password: string, logger: FastifyBaseLogger) => Promise<ILoginResult>;
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

// Служебная ошибка для отката транзакции при конкурентной ротации одного токена.
class ConcurrentRotationError extends Error {
  constructor() {
    super('Конкурентная ротация refresh-токена');
    this.name = 'ConcurrentRotationError';
  }
}

/**
 * Фабрика сервиса auth. Состояние лимитера — per-instance:
 * параллельные buildApp в тестах не разделяют счётчики.
 * Ограничение: при 2+ инстансах приложения счётчик не разделяется (MVP, см. план).
 */
export const createAuthService = (options: IAuthServiceOptions): IAuthService => {
  const { db, refreshTokenTtlSec, signAccessToken } = options;
  const failedAttempts = new Map<
    string,
    { count: number; lockedUntil: number | null; lastFailureAt: number }
  >();

  /** Запись устарела: блокировка истекла либо с последней неудачи прошло больше FAILURE_TTL_MS. */
  const isStaleState = (
    state: { lockedUntil: number | null; lastFailureAt: number },
    now: number,
  ): boolean =>
    state.lockedUntil !== null
      ? state.lockedUntil <= now
      : state.lastFailureAt + FAILURE_TTL_MS <= now;

  let lastSweepAt = 0;

  const sweepStaleStates = (now: number): void => {
    if (now - lastSweepAt < SWEEP_MIN_INTERVAL_MS) {
      return;
    }
    lastSweepAt = now;

    for (const [email, state] of failedAttempts) {
      if (isStaleState(state, now)) {
        failedAttempts.delete(email);
      }
    }
  };

  const assertNotLocked = (email: string): void => {
    const state = failedAttempts.get(email);

    if (state === undefined) {
      return;
    }

    if (isStaleState(state, Date.now())) {
      // Блокировка или окно счётчика истекли: счётчик начинается заново.
      failedAttempts.delete(email);
      return;
    }

    if (state.lockedUntil !== null) {
      throw new AppError(429, ErrorCodeEnum.TooManyAttempts, 'Too many failed login attempts');
    }
  };

  const registerFailure = (email: string): void => {
    const now = Date.now();

    if (failedAttempts.size >= FAILED_ATTEMPTS_SWEEP_THRESHOLD && !failedAttempts.has(email)) {
      sweepStaleStates(now);
    }

    const state = failedAttempts.get(email) ?? { count: 0, lockedUntil: null, lastFailureAt: now };
    state.count += 1;
    state.lastFailureAt = now;

    if (state.count >= MAX_FAILED_ATTEMPTS) {
      state.lockedUntil = now + LOCKOUT_MS;
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
      // Verify выполняется всегда (для неизвестного email — по фиктивному хешу):
      // ни тело ответа, ни тайминг не раскрывают существование аккаунта.
      const verified = await verify(record?.passwordHash ?? DUMMY_PASSWORD_HASH, password);
      const passwordValid = record !== null && record.isActive && verified;

      if (!passwordValid) {
        registerFailure(normalized);
        logger.debug('логин отклонён: неверные учётные данные');
        throw invalidCredentialsError();
      }

      failedAttempts.delete(normalized);
      const pair = await issueTokenPair(record.id, record.role, randomUUID());
      logger.info({ userId: record.id }, 'логин успешен, выпущена пара токенов');

      const user: IUserView = {
        id: record.id,
        email: record.email,
        role: record.role,
        displayName: record.displayName,
        isActive: record.isActive,
        createdAt: record.createdAt.toISOString(),
      };

      return { ...pair, user };
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
        logger.warn(
          { familyId: session.familyId, userId: session.userId },
          'replay refresh-токена: семья отозвана',
        );
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
      // Если старую сессию уже отозвала конкурентная ротация — это replay:
      // транзакция откатывается, семья отзывается целиком (FR-02).
      const newRefreshToken = generateRefreshToken();
      try {
        await db.transaction(async (tx) => {
          const revoked = await revokeSessionById(tx, session.id);

          if (!revoked) {
            throw new ConcurrentRotationError();
          }

          await insertSession(tx, {
            userId: session.userId,
            tokenHash: hashToken(newRefreshToken),
            familyId: session.familyId,
            expiresAt: new Date(Date.now() + refreshTokenTtlSec * 1000),
          });
        });
      } catch (error) {
        if (error instanceof ConcurrentRotationError) {
          await revokeFamilySessions(db, session.familyId);
          logger.warn(
            { familyId: session.familyId, userId: session.userId },
            'конкурентная ротация refresh-токена: семья отозвана',
          );
          throw invalidRefreshError();
        }
        throw error;
      }

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

/**
 * Зачистка просроченных refresh-сессий: удаляет строки с expiresAt < now() - graceDays
 * (по revokedAt не удаляем — просроченная отозванная строка теряет ценность для replay-детекции
 * независимо от revokedAt, см. план). Батч по CLEANUP_BATCH_LIMIT в цикле до исчерпания.
 * Возвращает суммарное число удалённых строк.
 */
export const cleanupExpiredSessions = async (
  db: NodePgDatabase,
  graceDays: number,
  logger: FastifyBaseLogger,
): Promise<number> => {
  const olderThan = new Date(Date.now() - graceDays * 24 * 60 * 60 * 1000);

  let deleted = 0;
  let batchDeleted: number;

  do {
    batchDeleted = await deleteExpiredSessions(db, olderThan, CLEANUP_BATCH_LIMIT);
    deleted += batchDeleted;
  } while (batchDeleted === CLEANUP_BATCH_LIMIT);

  logger.info({ deleted }, 'зачистка просроченных refresh-сессий завершена');

  return deleted;
};
