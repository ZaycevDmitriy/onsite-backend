import { Convert, Default, Errors, Check, Clean } from 'typebox/value';

import { envSchema, type IEnv, type NodeEnvEnum, type LogLevelEnum } from './env-schema.js';

// Итоговый типизированный конфиг приложения (camelCase-представление env).
export interface IAppConfig {
  nodeEnv: NodeEnvEnum;
  host: string;
  port: number;
  logLevel: LogLevelEnum;
  databaseUrl: string;
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
  };
};
