import helmet from '@fastify/helmet';
import Fastify from 'fastify';

import { authRoutes, createAuthService } from '@/modules/auth/index.js';
import { healthRoutes } from '@/modules/health/index.js';
import { ordersRoutes } from '@/modules/orders/index.js';
import { getActiveUser, usersRoutes } from '@/modules/users/index.js';
import { dbPlugin } from '@/shared/db/index.js';
import { errorHandler, notFoundHandler } from '@/shared/errors/index.js';
import {
  authPlugin,
  buildLoggerOptions,
  genReqId,
  openapiPlugin,
  s3Plugin,
} from '@/shared/plugins/index.js';

import type { IAppConfig } from '@/shared/config/index.js';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';

/**
 * Composition root: собирает Fastify-приложение из конфига.
 * Чистая фабрика без side effects — интеграционные тесты работают через app.inject().
 */
export const buildApp = async (config: IAppConfig): Promise<FastifyInstance> => {
  const options: FastifyServerOptions = {
    logger: buildLoggerOptions(config),
    genReqId,
  };
  const app = Fastify(options).withTypeProvider<TypeBoxTypeProvider>();

  app.log.debug({ nodeEnv: config.nodeEnv }, 'инициализация приложения');

  // contentSecurityPolicy отключён только для Swagger UI на /docs.
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(dbPlugin, { databaseUrl: config.databaseUrl });
  await app.register(s3Plugin, {
    endpoint: config.s3Endpoint,
    publicEndpoint: config.s3PublicEndpoint,
    region: config.s3Region,
    accessKeyId: config.s3AccessKey,
    secretAccessKey: config.s3SecretKey,
    bucket: config.s3Bucket,
  });
  await app.register(openapiPlugin);

  // getActiveUser инъецируется из публичного API users: shared не импортирует modules.
  await app.register(authPlugin, {
    privateKey: config.jwtPrivateKey,
    publicKey: config.jwtPublicKey,
    accessTokenTtlSec: config.accessTokenTtlSec,
    getActiveUser: (userId) => getActiveUser(app.db, userId),
  });

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);

  const authService = createAuthService({
    db: app.db,
    refreshTokenTtlSec: config.refreshTokenTtlSec,
    signAccessToken: (payload) => app.jwt.sign(payload),
  });

  // Модули (по мере появления фаз добавляются сюда).
  await app.register(healthRoutes);
  await app.register(authRoutes, { authService });
  // Отзыв сессий при сбросе пароля users получает инъекцией: цикла users ↔ auth нет.
  await app.register(usersRoutes, {
    revokeAllUserSessions: (userId, logger) => authService.revokeAllUserSessions(userId, logger),
  });
  await app.register(ordersRoutes);

  return app;
};
