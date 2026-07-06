import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from '@/shared/config/index.js';

// Тестовая пара RS256: генерируется на лету, в репозитории ключей нет.
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const toBase64 = (pem: string): string => Buffer.from(pem, 'utf8').toString('base64');

const validEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://onsite:onsite@localhost:5432/onsite',
  JWT_PRIVATE_KEY: toBase64(privateKey),
  JWT_PUBLIC_KEY: toBase64(publicKey),
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
      jwtPrivateKey: privateKey,
      jwtPublicKey: publicKey,
      accessTokenTtlSec: 900,
      refreshTokenTtlSec: 2592000,
    });
  });

  it('конвертирует PORT из строки в число', () => {
    const config = loadConfig({ ...validEnv, PORT: '8080' });

    expect(config.port).toBe(8080);
  });

  it('конвертирует TTL токенов из строк в числа', () => {
    const config = loadConfig({
      ...validEnv,
      ACCESS_TOKEN_TTL_SEC: '600',
      REFRESH_TOKEN_TTL_SEC: '86400',
    });

    expect(config.accessTokenTtlSec).toBe(600);
    expect(config.refreshTokenTtlSec).toBe(86400);
  });

  it('падает без DATABASE_URL', () => {
    const { DATABASE_URL: _omitted, ...withoutDb } = validEnv;

    expect(() => loadConfig(withoutDb)).toThrow(ConfigError);
  });

  it('падает без JWT-ключей', () => {
    const { JWT_PRIVATE_KEY: _omitted, ...withoutKey } = validEnv;

    expect(() => loadConfig(withoutKey)).toThrow(ConfigError);
  });

  it('падает, если JWT-ключ — не base64-кодированный PEM', () => {
    expect(() => loadConfig({ ...validEnv, JWT_PUBLIC_KEY: toBase64('не pem') })).toThrow(
      ConfigError,
    );
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

  it('не включает содержимое ключа в сообщение об ошибке PEM', () => {
    try {
      loadConfig({ ...validEnv, JWT_PRIVATE_KEY: toBase64('секретное содержимое') });
      expect.unreachable('ожидалась ConfigError');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).not.toContain('секретное');
    }
  });
});
