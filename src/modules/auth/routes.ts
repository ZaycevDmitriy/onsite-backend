import { errorEnvelopeSchema } from '@/shared/errors/index.js';

import { loginBodySchema, refreshBodySchema, tokenPairSchema } from './schemas.js';

import type { IAuthService } from './service.js';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';

export interface IAuthRoutesOptions {
  authService: IAuthService;
  // Жёсткий rate limit на /v1/auth/* поверх глобального (FR-18, T-17, решение #7 фазы 6).
  rateLimit: { max: number; timeWindowMs: number };
}

// Роуты тонкие: TypeBox-схема + вызов сервиса, бизнес-логика в service.ts.
export const authRoutes: FastifyPluginAsyncTypebox<IAuthRoutesOptions> =
  // eslint-disable-next-line @typescript-eslint/require-await -- Сигнатура async-плагина Fastify.
  async (app, { authService, rateLimit }) => {
    const authRateLimitConfig = {
      rateLimit: { max: rateLimit.max, timeWindow: rateLimit.timeWindowMs },
    };

    app.post(
      '/v1/auth/login',
      {
        config: authRateLimitConfig,
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
        config: authRateLimitConfig,
        schema: {
          tags: ['auth'],
          body: refreshBodySchema,
          response: {
            200: tokenPairSchema,
            401: errorEnvelopeSchema,
            429: errorEnvelopeSchema,
          },
        },
      },
      async (request) => authService.refresh(request.body.refreshToken, request.log),
    );

    app.post(
      '/v1/auth/logout',
      {
        config: authRateLimitConfig,
        schema: {
          tags: ['auth'],
          body: refreshBodySchema,
          response: {
            204: { type: 'null', description: 'Сессия отозвана' },
            429: errorEnvelopeSchema,
          },
        },
      },
      async (request, reply) => {
        await authService.logout(request.body.refreshToken, request.log);

        return reply.code(204).send(null);
      },
    );
  };
