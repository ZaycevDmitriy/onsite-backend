import fastifyJwt from '@fastify/jwt';
import fp from 'fastify-plugin';

import { AppError, ErrorCodeEnum } from '@/shared/errors/index.js';

import type { FastifyReply, FastifyRequest } from 'fastify';

// Роли дублируются строковыми литералами: shared не импортирует modules.
export type AuthRole = 'dispatcher' | 'technician';

// Издатель и аудитория access-токена: токены, подписанные этими же ключами
// для другого сервиса, верификацию не пройдут.
const JWT_ISSUER = 'onsite-backend';
const JWT_AUDIENCE = 'onsite-app';

// Payload access-токена: subject — id пользователя, роль — для requireRole.
export interface IAccessTokenPayload {
  sub: string;
  role: AuthRole;
}

// Пользователь, которого authenticate кладёт в request.user после верификации.
export interface IAuthenticatedUser {
  id: string;
  role: AuthRole;
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: IAccessTokenPayload;
    user: IAuthenticatedUser;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireRole: (
      role: AuthRole,
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export interface IAuthPluginOptions {
  // PEM-ключи RS256 из конфига.
  privateKey: string;
  publicKey: string;
  accessTokenTtlSec: number;
  /**
   * Возвращает активного пользователя по id или null.
   * Инъецируется composition root'ом из @/modules/users: shared не знает о модулях.
   */
  getActiveUser: (userId: string) => Promise<IAuthenticatedUser | null>;
}

/**
 * Плагин аутентификации: JWT RS256 + декораторы authenticate и requireRole.
 * authenticate после верификации токена проверяет пользователя в БД —
 * деактивация действует немедленно, не дожидаясь истечения access-токена (FR-04).
 */
export const authPlugin = fp<IAuthPluginOptions>(
  async (app, options) => {
    await app.register(fastifyJwt, {
      secret: { private: options.privateKey, public: options.publicKey },
      sign: {
        algorithm: 'RS256',
        expiresIn: options.accessTokenTtlSec,
        iss: JWT_ISSUER,
        aud: JWT_AUDIENCE,
      },
      // requiredClaims обязателен: allowedIss/allowedAud в fast-jwt проверяют клейм,
      // только если он присутствует — токен без iss/aud иначе прошёл бы верификацию.
      verify: {
        allowedIss: JWT_ISSUER,
        allowedAud: JWT_AUDIENCE,
        requiredClaims: ['iss', 'aud'],
      },
    });

    app.decorate('authenticate', async (request: FastifyRequest) => {
      let payload: IAccessTokenPayload;

      try {
        payload = await request.jwtVerify<IAccessTokenPayload>();
      } catch {
        request.log.debug('верификация access-токена не пройдена');
        throw new AppError(401, ErrorCodeEnum.Unauthorized, 'Invalid or missing access token');
      }

      const activeUser = await options.getActiveUser(payload.sub);

      if (activeUser === null) {
        request.log.debug({ userId: payload.sub }, 'пользователь не найден или деактивирован');
        throw new AppError(401, ErrorCodeEnum.Unauthorized, 'Invalid or missing access token');
      }

      // request.user перезаписывается данными из БД: роль актуальна, не из токена.
      request.user = activeUser;
      request.log.debug({ userId: activeUser.id, role: activeUser.role }, 'запрос аутентифицирован');
    });

    app.decorate(
      'requireRole',
      (role: AuthRole) =>
        // eslint-disable-next-line @typescript-eslint/require-await -- Сигнатура preHandler Fastify.
        async (request: FastifyRequest) => {
          if (request.user.role !== role) {
            request.log.debug(
              { userId: request.user.id, requiredRole: role },
              'доступ запрещён: недостаточная роль',
            );
            throw new AppError(403, ErrorCodeEnum.Forbidden, 'Insufficient role');
          }
        },
    );

    app.log.debug('auth-плагин зарегистрирован (RS256)');
  },
  { name: 'auth' },
);
