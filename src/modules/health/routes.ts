import { DepStatusEnum, HealthStatusEnum, healthResponseSchema } from './schemas.js';

import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';

/**
 * Liveness + статус зависимостей. Недоступная БД — degraded с 200, не 500:
 * сам процесс жив, оркестратору не нужно его перезапускать.
 * Проверка S3 добавится в Фазе 4 вместе с кодом фото.
 */
// eslint-disable-next-line @typescript-eslint/require-await -- Сигнатура async-плагина Fastify.
export const healthRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/v1/health',
    { config: { rateLimit: false }, schema: { response: { 200: healthResponseSchema } } },
    async (request) => {
      let db: DepStatusEnum = DepStatusEnum.Ok;

      try {
        await app.pg.query('SELECT 1');
      } catch (error) {
        request.log.warn({ err: error }, 'health: БД недоступна');
        db = DepStatusEnum.Unavailable;
      }

      return {
        status: db === DepStatusEnum.Ok ? HealthStatusEnum.Ok : HealthStatusEnum.Degraded,
        deps: { db },
      };
    },
  );
};
