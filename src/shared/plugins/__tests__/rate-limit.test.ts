import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { errorHandler } from '@/shared/errors/index.js';
import { rateLimitPlugin } from '@/shared/plugins/index.js';

import type { FastifyInstance } from 'fastify';

describe('rateLimitPlugin', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    app.setErrorHandler(errorHandler);
    await app.register(rateLimitPlugin, { max: 3, timeWindowMs: 60_000 });

    app.get('/rl/global', () => ({ ok: true }));
    app.get('/rl/unlimited', { config: { rateLimit: false } }, () => ({ ok: true }));
    app.get('/rl/strict', { config: { rateLimit: { max: 1, timeWindow: 60_000 } } }, () => ({
      ok: true,
    }));

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('пропускает запросы в пределах лимита, превышение → 429 единым конвертом (FR-18)', async () => {
    for (let i = 0; i < 3; i += 1) {
      const response = await app.inject({ method: 'GET', url: '/rl/global' });
      expect(response.statusCode).toBe(200);
    }

    const exceeded = await app.inject({ method: 'GET', url: '/rl/global' });

    expect(exceeded.statusCode).toBe(429);
    expect(exceeded.json<{ code: string; message: string }>()).toMatchObject({
      code: 'too_many_attempts',
    });
  });

  it('config.rateLimit: false отключает лимит на роуте (health/metrics)', async () => {
    for (let i = 0; i < 10; i += 1) {
      const response = await app.inject({ method: 'GET', url: '/rl/unlimited' });
      expect(response.statusCode).toBe(200);
    }
  });

  it('пер-роут override заводит независимый более строгий лимит (T-17)', async () => {
    const first = await app.inject({ method: 'GET', url: '/rl/strict' });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({ method: 'GET', url: '/rl/strict' });
    expect(second.statusCode).toBe(429);
  });
});
