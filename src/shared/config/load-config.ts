import { Convert, Default, Errors, Check, Clean } from 'typebox/value';

import { envSchema, type IEnv, type NodeEnvEnum, type LogLevelEnum } from './env-schema.js';

// Итоговый типизированный конфиг приложения (camelCase-представление env).
export interface IAppConfig {
  nodeEnv: NodeEnvEnum;
  host: string;
  port: number;
  logLevel: LogLevelEnum;
  databaseUrl: string;
  // PEM-ключи RS256, декодированные из base64-значений env.
  jwtPrivateKey: string;
  jwtPublicKey: string;
  accessTokenTtlSec: number;
  refreshTokenTtlSec: number;
  refreshCleanupIntervalMin: number;
  refreshExpiredGraceDays: number;
  // S3/MinIO: хранилище фотоотчётов.
  s3Endpoint: string;
  s3PublicEndpoint: string;
  s3Region: string;
  s3AccessKey: string;
  s3SecretKey: string;
  s3Bucket: string;
  photoMaxSizeMb: number;
  photoPresignTtlSec: number;
  photoStagedTtlHours: number;
  photoCleanupIntervalMin: number;
  syncSafetyLag: number;
  // Expo Push (T-16).
  expoAccessToken: string | undefined;
  pushWorkerIntervalSec: number;
  pushReceiptDelayMin: number;
  pushMaxAttempts: number;
  // Rate limiting (T-17).
  rateLimitGlobalMax: number;
  rateLimitGlobalWindowMs: number;
  rateLimitAuthMax: number;
  rateLimitAuthWindowMs: number;
}

// Ошибка конфигурации: процесс обязан упасть при старте, значения env в сообщение не попадают.
export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Невалидная конфигурация env: ${issues.join('; ')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Парсит и валидирует переменные окружения по TypeBox-схеме.
 * Порядок: подстановка default → конвертация строк env к типам → проверка.
 * В сообщениях об ошибках — только пути и правила, без значений (секреты не утекают).
 */
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): IAppConfig => {
  // Пустая строка трактуется как отсутствие значения: compose подставляет `${VAR:-}`
  // для незаданных переменных, и Optional-поля с minLength иначе валят валидацию.
  const normalized = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
  const withDefaults = Default(envSchema, Clean(envSchema, normalized));
  const converted = Convert(envSchema, withDefaults);

  if (!Check(envSchema, converted)) {
    const issues = [...Errors(envSchema, converted)].map(
      (error) => `${error.instancePath || '<root>'}: ${error.message}`,
    );
    throw new ConfigError(issues);
  }

  const parsed: IEnv = converted;

  return {
    nodeEnv: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    databaseUrl: parsed.DATABASE_URL,
    jwtPrivateKey: decodePemKey('JWT_PRIVATE_KEY', parsed.JWT_PRIVATE_KEY),
    jwtPublicKey: decodePemKey('JWT_PUBLIC_KEY', parsed.JWT_PUBLIC_KEY),
    accessTokenTtlSec: parsed.ACCESS_TOKEN_TTL_SEC,
    refreshTokenTtlSec: parsed.REFRESH_TOKEN_TTL_SEC,
    refreshCleanupIntervalMin: parsed.REFRESH_CLEANUP_INTERVAL_MIN,
    refreshExpiredGraceDays: parsed.REFRESH_EXPIRED_GRACE_DAYS,
    s3Endpoint: parsed.S3_ENDPOINT,
    // Публичный эндпоинт по умолчанию совпадает с внутренним (решение #8).
    s3PublicEndpoint: parsed.S3_PUBLIC_ENDPOINT ?? parsed.S3_ENDPOINT,
    s3Region: parsed.S3_REGION,
    s3AccessKey: parsed.S3_ACCESS_KEY,
    s3SecretKey: parsed.S3_SECRET_KEY,
    s3Bucket: parsed.S3_BUCKET,
    photoMaxSizeMb: parsed.PHOTO_MAX_SIZE_MB,
    photoPresignTtlSec: parsed.PHOTO_PRESIGN_TTL_SEC,
    photoStagedTtlHours: parsed.PHOTO_STAGED_TTL_HOURS,
    photoCleanupIntervalMin: parsed.PHOTO_CLEANUP_INTERVAL_MIN,
    syncSafetyLag: parsed.SYNC_SAFETY_LAG,
    expoAccessToken: parsed.EXPO_ACCESS_TOKEN,
    pushWorkerIntervalSec: parsed.PUSH_WORKER_INTERVAL_SEC,
    pushReceiptDelayMin: parsed.PUSH_RECEIPT_DELAY_MIN,
    pushMaxAttempts: parsed.PUSH_MAX_ATTEMPTS,
    rateLimitGlobalMax: parsed.RATE_LIMIT_GLOBAL_MAX,
    rateLimitGlobalWindowMs: parsed.RATE_LIMIT_GLOBAL_WINDOW_MS,
    rateLimitAuthMax: parsed.RATE_LIMIT_AUTH_MAX,
    rateLimitAuthWindowMs: parsed.RATE_LIMIT_AUTH_WINDOW_MS,
  };
};

/**
 * Декодирует base64-значение env в PEM-ключ.
 * В сообщении об ошибке — только имя переменной, без содержимого.
 */
const decodePemKey = (name: string, base64Value: string): string => {
  const pem = Buffer.from(base64Value, 'base64').toString('utf8');

  if (!pem.includes('-----BEGIN') || !pem.includes('KEY-----')) {
    throw new ConfigError([`${name}: ожидается base64-кодированный PEM-ключ`]);
  }

  return pem;
};
