import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from '@/shared/config/index.js';

const validEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://onsite:onsite@localhost:5432/onsite',
};

describe('loadConfig', () => {
  it('парсит валидный env и применяет дефолты', () => {
    const config = loadConfig(validEnv);

    expect(config).toEqual({
      nodeEnv: 'test',
      host: '0.0.0.0',
      port: 3000,
      logLevel: 'info',
      databaseUrl: validEnv.DATABASE_URL,
    });
  });

  it('конвертирует PORT из строки в число', () => {
    const config = loadConfig({ ...validEnv, PORT: '8080' });

    expect(config.port).toBe(8080);
  });

  it('падает без DATABASE_URL', () => {
    expect(() => loadConfig({ NODE_ENV: 'test' })).toThrow(ConfigError);
  });

  it('падает на неизвестном LOG_LEVEL', () => {
    expect(() => loadConfig({ ...validEnv, LOG_LEVEL: 'loud' })).toThrow(ConfigError);
  });

  it('падает на PORT вне диапазона', () => {
    expect(() => loadConfig({ ...validEnv, PORT: '70000' })).toThrow(ConfigError);
  });

  it('не включает значения env в сообщение об ошибке', () => {
    try {
      loadConfig({ ...validEnv, DATABASE_URL: '' });
      expect.unreachable('ожидалась ConfigError');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).not.toContain('postgres://');
    }
  });
});
