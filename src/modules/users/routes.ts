import { errorEnvelopeSchema } from '@/shared/errors/index.js';

import {
  createUserBodySchema,
  updateUserBodySchema,
  userIdParamsSchema,
  userViewSchema,
} from './schemas.js';
import { createUser, updateUser } from './service.js';

import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyBaseLogger } from 'fastify';

export interface IUsersRoutesOptions {
  /**
   * Отзыв всех refresh-сессий пользователя при сбросе пароля (§9.8).
   * Инъецируется из @/modules/auth composition root'ом: users auth не импортирует.
   */
  revokeAllUserSessions: (userId: string, logger: FastifyBaseLogger) => Promise<void>;
}

// Управление аккаунтами: только диспетчер (FR-03, FR-04).
export const usersRoutes: FastifyPluginAsyncTypebox<IUsersRoutesOptions> =
  // eslint-disable-next-line @typescript-eslint/require-await -- Сигнатура async-плагина Fastify.
  async (app, { revokeAllUserSessions }) => {
  const dispatcherOnly = [app.authenticate, app.requireRole('dispatcher')];

  app.post(
    '/v1/users',
    {
      preHandler: dispatcherOnly,
      schema: {
        tags: ['users'],
        security: [{ bearerAuth: [] }],
        body: createUserBodySchema,
        response: {
          201: userViewSchema,
          401: errorEnvelopeSchema,
          403: errorEnvelopeSchema,
          409: errorEnvelopeSchema,
          422: errorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const user = await createUser(app.db, request.body, request.log);

      return reply.code(201).send(user);
    },
  );

  app.patch(
    '/v1/users/:id',
    {
      preHandler: dispatcherOnly,
      schema: {
        tags: ['users'],
        security: [{ bearerAuth: [] }],
        params: userIdParamsSchema,
        body: updateUserBodySchema,
        response: {
          200: userViewSchema,
          401: errorEnvelopeSchema,
          403: errorEnvelopeSchema,
          404: errorEnvelopeSchema,
          422: errorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const { user, passwordChanged } = await updateUser(
        app.db,
        request.params.id,
        request.body,
        request.user.id,
        request.log,
      );

      // Сброс пароля инвалидирует все refresh-сессии пользователя.
      if (passwordChanged) {
        await revokeAllUserSessions(user.id, request.log);
      }

      return user;
    },
  );
};
