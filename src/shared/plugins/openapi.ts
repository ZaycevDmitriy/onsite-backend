import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import fp from 'fastify-plugin';

/**
 * OpenAPI 3.1 из TypeBox-схем роутов + Swagger UI на /docs.
 * Контракт генерируется из кода — расхождение схем и реализации исключено (NFR-06).
 */
export const openapiPlugin = fp(
  async (app) => {
    await app.register(swagger, {
      openapi: {
        openapi: '3.1.0',
        info: {
          title: 'Onsite Backend API',
          description: 'REST API мобильной mini-CRM выездных сервисных работников',
          version: '0.0.0',
        },
        servers: [{ url: '/' }],
      },
    });

    await app.register(swaggerUi, { routePrefix: '/docs' });
  },
  { name: 'openapi' },
);
