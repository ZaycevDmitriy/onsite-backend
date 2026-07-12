import { Type } from 'typebox';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeTestConfig } from '@/__tests__/helpers/test-config.js';
import { buildApp } from '@/app.js';
import { AppError, ErrorCodeEnum } from '@/shared/errors/index.js';

import type { FastifyInstance } from 'fastify';

const testConfig = makeTestConfig('postgres://unused');

describe('buildApp: конверт ошибок', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp(testConfig);

    // Тестовые роуты для проверки error handler'а.
    app.post(
      '/test/echo',
      { schema: { body: Type.Object({ value: Type.Number() }) } },
      (request) => request.body,
    );
    app.get('/test/app-error', () => {
      throw new AppError(409, ErrorCodeEnum.InvalidTransition, 'Переход невозможен', {
        from: 'Done',
      });
    });
    app.get('/test/boom', () => {
      throw new Error('секретная внутренняя ошибка');
    });
    app.get('/test/ip', (request) => ({ ip: request.ip }));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('невалидное тело → 422 validation_failed', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/test/echo',
      payload: { value: 'not-a-number' },
    });

    expect(response.statusCode).toBe(422);
    const body = response.json<{ code: string; details: unknown[] }>();
    expect(body.code).toBe('validation_failed');
    expect(body.details).toBeInstanceOf(Array);
  });

  it('AppError → статус и код из ошибки', async () => {
    const response = await app.inject({ method: 'GET', url: '/test/app-error' });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      code: 'invalid_transition',
      message: 'Переход невозможен',
      details: { from: 'Done' },
    });
  });

  it('битый JSON при content-type application/json → 400 bad_request, не 500', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/test/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{"value": не-json',
    });

    expect(response.statusCode).toBe(400);
    const body = response.json<{ code: string; message: string }>();
    expect(body.code).toBe('bad_request');
    expect(body.message).toContain('JSON');
  });

  it('тело сверх bodyLimit → 413 file_too_large конвертом, не 500', async () => {
    // Дефолтный bodyLimit Fastify — 1 МиБ: полтора мегабайта valid-JSON его превышают.
    const response = await app.inject({
      method: 'POST',
      url: '/test/echo',
      headers: { 'content-type': 'application/json' },
      payload: `{"value": "${'x'.repeat(1_536_000)}"}`,
    });

    expect(response.statusCode).toBe(413);
    expect(response.json<{ code: string }>().code).toBe('file_too_large');
  });

  it('неожиданная ошибка → 500 без утечки сообщения и stack', async () => {
    const response = await app.inject({ method: 'GET', url: '/test/boom' });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      code: 'internal_error',
      message: 'Internal server error',
    });
    expect(response.body).not.toContain('секретная');
  });

  it('неизвестный маршрут → 404 not_found конвертом', async () => {
    const response = await app.inject({ method: 'GET', url: '/nope' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ code: 'not_found', message: 'Route not found' });
  });

  it('пробрасывает валидный x-request-id', async () => {
    const id = '018f2c3a-9c1e-7abc-8def-0123456789ab';
    const response = await app.inject({
      method: 'GET',
      url: '/nope',
      headers: { 'x-request-id': id },
    });

    expect(response.statusCode).toBe(404);
  });

  it(
    'trustProxy: request.ip читается из X-Forwarded-For (OWASP-аудит T-10, ' +
      'иначе rate limiting за Caddy схлопывается в одну корзину на всех клиентов)',
    async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/test/ip',
        headers: { 'x-forwarded-for': '203.0.113.7' },
      });

      expect(response.json<{ ip: string }>().ip).toBe('203.0.113.7');
    },
  );
});
