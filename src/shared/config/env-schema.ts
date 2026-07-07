import { Type, type Static } from 'typebox';

// Допустимые окружения приложения.
export const NodeEnvEnum = {
  Development: 'development',
  Production: 'production',
  Test: 'test',
} as const;
export type NodeEnvEnum = (typeof NodeEnvEnum)[keyof typeof NodeEnvEnum];

// Уровни логирования pino.
export const LogLevelEnum = {
  Trace: 'trace',
  Debug: 'debug',
  Info: 'info',
  Warn: 'warn',
  Error: 'error',
  Fatal: 'fatal',
} as const;
export type LogLevelEnum = (typeof LogLevelEnum)[keyof typeof LogLevelEnum];

// Схема переменных окружения: единственный источник истины по конфигу процесса.
export const envSchema = Type.Object({
  NODE_ENV: Type.Union(
    [
      Type.Literal(NodeEnvEnum.Development),
      Type.Literal(NodeEnvEnum.Production),
      Type.Literal(NodeEnvEnum.Test),
    ],
    { default: NodeEnvEnum.Development },
  ),
  HOST: Type.String({ default: '0.0.0.0' }),
  PORT: Type.Number({ minimum: 1, maximum: 65535, default: 3000 }),
  LOG_LEVEL: Type.Union(
    [
      Type.Literal(LogLevelEnum.Trace),
      Type.Literal(LogLevelEnum.Debug),
      Type.Literal(LogLevelEnum.Info),
      Type.Literal(LogLevelEnum.Warn),
      Type.Literal(LogLevelEnum.Error),
      Type.Literal(LogLevelEnum.Fatal),
    ],
    { default: LogLevelEnum.Info },
  ),
  DATABASE_URL: Type.String({ minLength: 1 }),
  // Ключи RS256 для JWT: base64-кодированный PEM (NFR-05, секреты вне git).
  JWT_PRIVATE_KEY: Type.String({ minLength: 1 }),
  JWT_PUBLIC_KEY: Type.String({ minLength: 1 }),
  // TTL access-токена в секундах (15 минут по умолчанию).
  ACCESS_TOKEN_TTL_SEC: Type.Number({ minimum: 1, default: 900 }),
  // TTL refresh-токена в секундах (30 дней по умолчанию).
  REFRESH_TOKEN_TTL_SEC: Type.Number({ minimum: 1, default: 2592000 }),
  // S3/MinIO: внутренний эндпоинт (api → хранилище по docker-сети).
  S3_ENDPOINT: Type.String({ minLength: 1 }),
  // Публичный эндпоинт для подписи presigned URL, доступного клиенту; по умолчанию — S3_ENDPOINT.
  S3_PUBLIC_ENDPOINT: Type.Optional(Type.String({ minLength: 1 })),
  S3_REGION: Type.String({ default: 'us-east-1' }),
  S3_ACCESS_KEY: Type.String({ minLength: 1 }),
  S3_SECRET_KEY: Type.String({ minLength: 1 }),
  S3_BUCKET: Type.String({ minLength: 1 }),
  // Лимит размера фото в мегабайтах (FR-11).
  PHOTO_MAX_SIZE_MB: Type.Number({ minimum: 1, default: 10 }),
  // TTL presigned URL выдачи фото в секундах (FR-12).
  PHOTO_PRESIGN_TTL_SEC: Type.Number({ minimum: 1, default: 600 }),
  // TTL staged-фото до зачистки как сироты в часах (T-13).
  PHOTO_STAGED_TTL_HOURS: Type.Number({ minimum: 1, default: 168 }),
  // Интервал запуска зачистки сирот в минутах (T-13).
  PHOTO_CLEANUP_INTERVAL_MIN: Type.Number({ minimum: 1, default: 60 }),
  // Safety-lag курсора pull-синхронизации в единицах sync_seq (FR-08, NFR-08, решение #1 фазы 5).
  SYNC_SAFETY_LAG: Type.Number({ minimum: 0, default: 100 }),
  // Access-токен Expo Push Service (enhanced security) — опционален, без него запросы идут анонимно.
  EXPO_ACCESS_TOKEN: Type.Optional(Type.String({ minLength: 1 })),
  // Интервал прогона push-worker'а (send + receipts) в секундах (T-16, решение #2 фазы 6).
  PUSH_WORKER_INTERVAL_SEC: Type.Number({ minimum: 1, default: 10 }),
  // Минимальный возраст тикета перед проверкой receipt'а в минутах (рекомендация Expo — ~15 мин).
  PUSH_RECEIPT_DELAY_MIN: Type.Number({ minimum: 1, default: 15 }),
  // Максимум попыток отправки записи outbox перед окончательным failed.
  PUSH_MAX_ATTEMPTS: Type.Number({ minimum: 1, default: 5 }),
  // Rate limiting (FR-18, T-17): глобальный лимит на IP.
  RATE_LIMIT_GLOBAL_MAX: Type.Number({ minimum: 1, default: 200 }),
  RATE_LIMIT_GLOBAL_WINDOW_MS: Type.Number({ minimum: 1, default: 60_000 }),
  // Жёсткий лимит на /v1/auth/* (защита от перебора логина/пароля).
  RATE_LIMIT_AUTH_MAX: Type.Number({ minimum: 1, default: 10 }),
  RATE_LIMIT_AUTH_WINDOW_MS: Type.Number({ minimum: 1, default: 60_000 }),
});

export type IEnv = Static<typeof envSchema>;
