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
  const withDefaults = Default(envSchema, Clean(envSchema, { ...env }));
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
