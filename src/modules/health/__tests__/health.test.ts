import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeTestConfig } from '@/__tests__/helpers/test-config.js';
import { buildApp } from '@/app.js';

import type { FastifyInstance } from 'fastify';

// Интеграционные тесты против реальной БД: DATABASE_URL задаёт CI/локальное окружение.
const databaseUrl = process.env.DATABASE_URL;

const makeConfig = makeTestConfig;

describe.runIf(databaseUrl)('/v1/health с доступной БД', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp(makeConfig(databaseUrl as string));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('отдаёт ok при живой БД', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', deps: { db: 'ok' } });
  });
});

describe('/v1/health с недоступной БД', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    // Заведомо недоступный порт: health обязан деградировать, а не падать.
    app = await buildApp(makeConfig('postgres://nobody:nothing@127.0.0.1:1/none'));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('отдаёт degraded с 200, не 500', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'degraded', deps: { db: 'unavailable' } });
  });
});

describe('OpenAPI', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp(makeConfig('postgres://unused:unused@localhost:5432/unused'));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('генерирует валидную спеку с /v1/health', () => {
    const spec = app.swagger() as { openapi?: string; paths?: Record<string, unknown> };

    expect(spec.openapi).toBe('3.1.0');
    expect(spec.paths).toHaveProperty('/v1/health');
  });

  it('/docs отдаёт Swagger UI', async () => {
    const response = await app.inject({ method: 'GET', url: '/docs' });

    expect([200, 302]).toContain(response.statusCode);
  });
});
