import helmet from '@fastify/helmet';
import Fastify from 'fastify';

import { healthRoutes } from '@/modules/health/index.js';
import { dbPlugin } from '@/shared/db/index.js';
import { errorHandler, notFoundHandler } from '@/shared/errors/index.js';
import { buildLoggerOptions, genReqId, openapiPlugin } from '@/shared/plugins/index.js';

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
  await app.register(openapiPlugin);

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);

  // Модули (по мере появления фаз добавляются сюда).
  await app.register(healthRoutes);

  return app;
};
