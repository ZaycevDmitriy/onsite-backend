import helmet from '@fastify/helmet';
import Fastify from 'fastify';

import { authRoutes, createAuthService } from '@/modules/auth/index.js';
import { healthRoutes } from '@/modules/health/index.js';
import {
  countOutboxByStatus,
  enqueueAssignmentPush,
  notificationsRoutes,
} from '@/modules/notifications/index.js';
import {
  applySyncTransition,
  getCurrentSyncSeq,
  listOrdersForSync,
  listUnassignedTombstones,
  ordersRoutes,
  recordSyncPhotoAdded,
} from '@/modules/orders/index.js';
import {
  commitStagedPhoto,
  findStagedPhotoForCommit,
  listCommittedPhotosByOrderId,
  listCommittedPhotosByOrderIds,
  photosRoutes,
} from '@/modules/photos/index.js';
import { syncRoutes } from '@/modules/sync/index.js';
import { getActiveUser, usersRoutes } from '@/modules/users/index.js';
import { dbPlugin } from '@/shared/db/index.js';
import { errorHandler, notFoundHandler } from '@/shared/errors/index.js';
import {
  authPlugin,
  buildLoggerOptions,
  genReqId,
  metricsPlugin,
  openapiPlugin,
  rateLimitPlugin,
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
    // За reverse-proxy (Caddy, решение #6 фазы 6) req.ip иначе всегда = IP прокси: rate limiting
    // по IP (T-17) схлопнется в одну корзину на всех клиентов (OWASP API8, находка аудита T-19).
    // Ровно 1 хоп, не true: доверие всей цепочке X-Forwarded-For позволило бы обойти
    // rate limit подделкой заголовка при деплое без Caddy перед api.
    trustProxy: 1,
  };
  const app = Fastify(options).withTypeProvider<TypeBoxTypeProvider>();

  app.log.debug({ nodeEnv: config.nodeEnv }, 'инициализация приложения');

  // contentSecurityPolicy отключён только для Swagger UI на /docs.
  await app.register(helmet, { contentSecurityPolicy: false });
  // Глобальный rate limiting на IP (FR-18, T-17): раньше остальных роутов — применяется ко всем.
  await app.register(rateLimitPlugin, {
    max: config.rateLimitGlobalMax,
    timeWindowMs: config.rateLimitGlobalWindowMs,
  });
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
  // countOutboxByStatus инъецируется из notifications: shared не импортирует modules (решение #4 фазы 6).
  await app.register(metricsPlugin, {
    countOutboxByStatus: () => countOutboxByStatus(app.db),
  });

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
  await app.register(authRoutes, {
    authService,
    rateLimit: { max: config.rateLimitAuthMax, timeWindowMs: config.rateLimitAuthWindowMs },
  });
  await app.register(notificationsRoutes);
  // Отзыв сессий при сбросе пароля users получает инъекцией: цикла users ↔ auth нет.
  await app.register(usersRoutes, {
    revokeAllUserSessions: (userId, logger) => authService.revokeAllUserSessions(userId, logger),
  });
  // Committed-фото в GET /v1/orders/:id инъецируются из photos: цикла orders ↔ photos нет,
  // так как orders не импортирует photos напрямую (решение #10).
  await app.register(ordersRoutes, {
    listCommittedPhotos: listCommittedPhotosByOrderId,
    enqueueAssignmentPush,
  });
  await app.register(photosRoutes, {
    maxFileSizeBytes: config.photoMaxSizeMb * 1024 * 1024,
    presignTtlSec: config.photoPresignTtlSec,
  });
  // Синк: pull/мутации — из orders/photos инъекциями, sync не импортирует их напрямую (решение #7 фазы 5).
  await app.register(syncRoutes, {
    listOrdersForSync,
    listUnassignedTombstones,
    getCurrentSyncSeq,
    listCommittedPhotosByOrderIds,
    safetyLag: config.syncSafetyLag,
    applySyncTransition,
    findStagedPhotoForCommit,
    commitStagedPhoto,
    recordSyncPhotoAdded,
  });

  return app;
};
