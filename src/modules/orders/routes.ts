import { errorEnvelopeSchema } from '@/shared/errors/index.js';

import {
  assignOrderBodySchema,
  createOrderBodySchema,
  listOrdersQuerySchema,
  listOrdersResponseSchema,
  orderDetailSchema,
  orderIdParamsSchema,
  orderViewSchema,
  transitionOrderBodySchema,
  updateOrderBodySchema,
} from './schemas.js';
import {
  assignOrder,
  createOrder,
  getOrder,
  listOrders,
  transitionOrder,
  updateOrder,
} from './service.js';

import type { IListCommittedPhotos } from './service.js';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';

export interface IOrdersRoutesOptions {
  // Committed-фото заявки: инъецируется из @/modules/photos композиционным корнем (решение #10).
  listCommittedPhotos: IListCommittedPhotos;
}

// Заявки: список/детали доступны обеим ролям, остальное — только dispatcher (FR-03).
export const ordersRoutes: FastifyPluginAsyncTypebox<IOrdersRoutesOptions> =
  // eslint-disable-next-line @typescript-eslint/require-await -- Сигнатура async-плагина Fastify.
  async (app, { listCommittedPhotos }) => {
  const dispatcherOnly = [app.authenticate, app.requireRole('dispatcher')];

  app.get(
    '/v1/orders',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['orders'],
        security: [{ bearerAuth: [] }],
        querystring: listOrdersQuerySchema,
        response: {
          200: listOrdersResponseSchema,
          401: errorEnvelopeSchema,
          422: errorEnvelopeSchema,
        },
      },
    },
    async (request) => listOrders(app.db, request.query, request.user, request.log),
  );

  app.post(
    '/v1/orders',
    {
      preHandler: dispatcherOnly,
      schema: {
        tags: ['orders'],
        security: [{ bearerAuth: [] }],
        body: createOrderBodySchema,
        response: {
          201: orderViewSchema,
          401: errorEnvelopeSchema,
          403: errorEnvelopeSchema,
          422: errorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const order = await createOrder(app.db, request.body, request.user, request.log);

      return reply.code(201).send(order);
    },
  );

  app.get(
    '/v1/orders/:id',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['orders'],
        security: [{ bearerAuth: [] }],
        params: orderIdParamsSchema,
        response: {
          200: orderDetailSchema,
          401: errorEnvelopeSchema,
          404: errorEnvelopeSchema,
        },
      },
    },
    async (request) =>
      getOrder(app.db, request.params.id, request.user, listCommittedPhotos, request.log),
  );

  app.patch(
    '/v1/orders/:id',
    {
      preHandler: dispatcherOnly,
      schema: {
        tags: ['orders'],
        security: [{ bearerAuth: [] }],
        params: orderIdParamsSchema,
        body: updateOrderBodySchema,
        response: {
          200: orderViewSchema,
          401: errorEnvelopeSchema,
          403: errorEnvelopeSchema,
          404: errorEnvelopeSchema,
          409: errorEnvelopeSchema,
          422: errorEnvelopeSchema,
        },
      },
    },
    async (request) => updateOrder(app.db, request.params.id, request.body, request.log),
  );

  app.post(
    '/v1/orders/:id/assign',
    {
      preHandler: dispatcherOnly,
      schema: {
        tags: ['orders'],
        security: [{ bearerAuth: [] }],
        params: orderIdParamsSchema,
        body: assignOrderBodySchema,
        response: {
          200: orderViewSchema,
          401: errorEnvelopeSchema,
          403: errorEnvelopeSchema,
          404: errorEnvelopeSchema,
          409: errorEnvelopeSchema,
          422: errorEnvelopeSchema,
        },
      },
    },
    async (request) =>
      assignOrder(app.db, request.params.id, request.body, request.user, request.log),
  );

  app.post(
    '/v1/orders/:id/transition',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['orders'],
        security: [{ bearerAuth: [] }],
        params: orderIdParamsSchema,
        body: transitionOrderBodySchema,
        response: {
          200: orderViewSchema,
          401: errorEnvelopeSchema,
          404: errorEnvelopeSchema,
          409: errorEnvelopeSchema,
        },
      },
    },
    async (request) =>
      transitionOrder(app.db, request.params.id, request.body, request.user, request.log),
  );
};
