import { errorEnvelopeSchema } from '@/shared/errors/index.js';

import { registerDeviceBodySchema } from './schemas.js';
import { registerDevice } from './service.js';

import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';

// Устройства: регистрация push-токена (FR-13).
export const notificationsRoutes: FastifyPluginAsyncTypebox =
  // eslint-disable-next-line @typescript-eslint/require-await -- Сигнатура async-плагина Fastify.
  async (app) => {
    app.put(
      '/v1/devices',
      {
        onRequest: [app.authenticate],
        schema: {
          tags: ['notifications'],
          security: [{ bearerAuth: [] }],
          body: registerDeviceBodySchema,
          response: {
            204: { type: 'null', description: 'Устройство зарегистрировано' },
            401: errorEnvelopeSchema,
            422: errorEnvelopeSchema,
          },
        },
      },
      async (request, reply) => {
        await registerDevice(app.db, request.body, request.user, request.log);

        return reply.code(204).send(null);
      },
    );
  };
