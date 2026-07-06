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
});

export type IEnv = Static<typeof envSchema>;
