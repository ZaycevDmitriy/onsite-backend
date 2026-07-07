import { errorEnvelopeSchema } from '@/shared/errors/index.js';

import { syncPullQuerySchema, syncPullResponseSchema } from './schemas.js';
import { pullSync } from './service.js';

import type { IPullSyncDeps } from './service.js';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';

// Дефолтный размер страницы pull, если limit не передан в query.
const DEFAULT_PULL_LIMIT = 200;

export interface ISyncRoutesOptions extends IPullSyncDeps {
  // Safety-lag курсора pull из конфига (SYNC_SAFETY_LAG, решение #1 фазы 5).
  safetyLag: number;
}

// Синк: оба эндпоинта — только technician (решение #9 фазы 5); pull отдаёт только свои заявки/tombstone.
export const syncRoutes: FastifyPluginAsyncTypebox<ISyncRoutesOptions> =
  // eslint-disable-next-line @typescript-eslint/require-await -- Сигнатура async-плагина Fastify.
  async (app, options) => {
    const technicianOnly = [app.authenticate, app.requireRole('technician')];

    app.get(
      '/v1/sync/orders',
      {
        preHandler: technicianOnly,
        schema: {
          tags: ['sync'],
          security: [{ bearerAuth: [] }],
          querystring: syncPullQuerySchema,
          response: {
            200: syncPullResponseSchema,
            401: errorEnvelopeSchema,
            403: errorEnvelopeSchema,
          },
        },
      },
      async (request) => {
        const cursor = request.query.cursor ?? 0;
        const limit = request.query.limit ?? DEFAULT_PULL_LIMIT;

        return pullSync(
          app.db,
          { requesterId: request.user.id, cursor, limit, safetyLag: options.safetyLag },
          options,
          request.log,
        );
      },
    );
  };
