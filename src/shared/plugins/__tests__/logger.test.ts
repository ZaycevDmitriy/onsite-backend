import { describe, expect, it } from 'vitest';

import { buildLoggerOptions } from '@/shared/plugins/index.js';

describe('buildLoggerOptions', () => {
  it('в dev включает pino-pretty и заданный уровень', () => {
    const options = buildLoggerOptions({ nodeEnv: 'development', logLevel: 'debug' });

    expect(options).toMatchObject({
      level: 'debug',
      transport: { target: 'pino-pretty' },
    });
  });

  it('в prod отдаёт JSON без transport', () => {
    const options = buildLoggerOptions({ nodeEnv: 'production', logLevel: 'info' });

    expect(options).toMatchObject({ level: 'info' });
    expect(options).not.toHaveProperty('transport');
  });

  it('редактирует авторизационные заголовки', () => {
    const options = buildLoggerOptions({ nodeEnv: 'production', logLevel: 'info' });

    const redact = (options as { redact: { paths: string[] } }).redact;

    expect(redact.paths).toContain('req.headers.authorization');
    expect(redact.paths).toContain('req.headers.cookie');
  });

  it('сериализатор запроса не включает тело и заголовки', () => {
    const options = buildLoggerOptions({ nodeEnv: 'production', logLevel: 'info' });
    const serializers = (options as { serializers: { req: (r: unknown) => unknown } }).serializers;
    const serialized = serializers.req({
      method: 'POST',
      url: '/v1/auth/login',
      body: { password: 'secret' },
      headers: { authorization: 'Bearer token' },
    });

    expect(serialized).toEqual({ method: 'POST', url: '/v1/auth/login' });
  });
});
