import { generateKeyPairSync } from 'node:crypto';

import type { IAppConfig } from '@/shared/config/index.js';

// Тестовая пара RS256: генерируется один раз на процесс, в репозитории ключей нет.
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

/** Собирает IAppConfig для интеграционных тестов с тестовыми JWT-ключами. */
export const makeTestConfig = (
  databaseUrl: string,
  overrides: Partial<IAppConfig> = {},
): IAppConfig => ({
  nodeEnv: 'test',
  host: '127.0.0.1',
  port: 0,
  logLevel: 'fatal',
  databaseUrl,
  jwtPrivateKey: privateKey,
  jwtPublicKey: publicKey,
  accessTokenTtlSec: 900,
  refreshTokenTtlSec: 2592000,
  refreshCleanupIntervalMin: 60,
  refreshExpiredGraceDays: 7,
  s3Endpoint: 'http://localhost:9000',
  s3PublicEndpoint: 'http://localhost:9000',
  s3Region: 'us-east-1',
  s3AccessKey: 'minioadmin',
  s3SecretKey: 'minioadmin',
  s3Bucket: 'onsite-photos',
  photoMaxSizeMb: 10,
  photoPresignTtlSec: 600,
  photoStagedTtlHours: 168,
  photoCleanupIntervalMin: 60,
  syncSafetyLag: 100,
  expoAccessToken: undefined,
  pushWorkerIntervalSec: 10,
  pushReceiptDelayMin: 15,
  pushMaxAttempts: 5,
  // Высокие лимиты по умолчанию: интеграционные тесты других модулей легитимно шлют много
  // запросов подряд (например, повторные login/refresh) и не должны попадать под 429.
  // Сам rate limiting проверяется отдельным тестом с точечным overrides маленьких значений.
  rateLimitGlobalMax: 10_000,
  rateLimitGlobalWindowMs: 60_000,
  rateLimitAuthMax: 10_000,
  rateLimitAuthWindowMs: 60_000,
  ...overrides,
});
