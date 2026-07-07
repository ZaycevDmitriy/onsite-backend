import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { errorHandler } from '@/shared/errors/index.js';
import { metricsPlugin } from '@/shared/plugins/index.js';

import type { FastifyInstance } from 'fastify';

describe('metricsPlugin', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    app.setErrorHandler(errorHandler);
    await app.register(metricsPlugin, {
      countOutboxByStatus: () => Promise.resolve({ pending: 2, sent: 1, failed: 0 }),
    });

    app.get('/items/:id', () => ({ ok: true }));

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('отдаёт /metrics в формате Prometheus (NFR-11)', async () => {
    const response = await app.inject({ method: 'GET', url: '/metrics' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
  });

  it('глубина outbox отражает инъецированные значения по статусам (T-20)', async () => {
    const response = await app.inject({ method: 'GET', url: '/metrics' });

    expect(response.body).toContain('push_outbox_depth{status="pending"} 2');
    expect(response.body).toContain('push_outbox_depth{status="sent"} 1');
    expect(response.body).toContain('push_outbox_depth{status="failed"} 0');
  });

  it('латентность считается по route-шаблону, не по сырому пути с id (unbounded cardinality)', async () => {
    await app.inject({ method: 'GET', url: '/items/018f2c3a-9c1e-7abc-8def-0123456789ab' });

    const response = await app.inject({ method: 'GET', url: '/metrics' });

    expect(response.body).toContain('route="/items/:id"');
    expect(response.body).not.toContain('018f2c3a-9c1e-7abc-8def-0123456789ab');
  });
});
