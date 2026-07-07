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
});

export type IEnv = Static<typeof envSchema>;
