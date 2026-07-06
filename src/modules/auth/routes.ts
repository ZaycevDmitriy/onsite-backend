import { errorEnvelopeSchema } from '@/shared/errors/index.js';

import { loginBodySchema, refreshBodySchema, tokenPairSchema } from './schemas.js';

import type { IAuthService } from './service.js';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';

export interface IAuthRoutesOptions {
  authService: IAuthService;
}

// Роуты тонкие: TypeBox-схема + вызов сервиса, бизнес-логика в service.ts.
export const authRoutes: FastifyPluginAsyncTypebox<IAuthRoutesOptions> =
  // eslint-disable-next-line @typescript-eslint/require-await -- Сигнатура async-плагина Fastify.
  async (app, { authService }) => {
  app.post(
    '/v1/auth/login',
    {
      schema: {
        tags: ['auth'],
        body: loginBodySchema,
        response: {
          200: tokenPairSchema,
          401: errorEnvelopeSchema,
          429: errorEnvelopeSchema,
        },
      },
    },
    async (request) => authService.login(request.body.email, request.body.password, request.log),
  );

  app.post(
    '/v1/auth/refresh',
    {
      schema: {
        tags: ['auth'],
        body: refreshBodySchema,
        response: {
          200: tokenPairSchema,
          401: errorEnvelopeSchema,
        },
      },
    },
    async (request) => authService.refresh(request.body.refreshToken, request.log),
  );

  app.post(
    '/v1/auth/logout',
    {
      schema: {
        tags: ['auth'],
        body: refreshBodySchema,
        response: {
          204: { type: 'null', description: 'Сессия отозвана' },
        },
      },
    },
    async (request, reply) => {
      await authService.logout(request.body.refreshToken, request.log);

      return reply.code(204).send(null);
    },
  );
};
