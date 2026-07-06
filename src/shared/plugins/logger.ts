import type { IAppConfig } from '@/shared/config/index.js';
import type { FastifyServerOptions } from 'fastify';
import type { PinoLoggerOptions } from 'fastify/types/logger.js';

// Опции логгера без undefined (совместимость с exactOptionalPropertyTypes).
export type ILoggerOptions = Exclude<FastifyServerOptions['logger'], undefined>;

// Поля, которые никогда не должны попасть в логи (NFR-07: секреты и авторизация).
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
];

/**
 * Собирает опции логгера pino для Fastify.
 * Dev: человекочитаемый вывод pino-pretty; prod/test: структурный JSON.
 * Тела запросов не логируются: сериализатор запроса ограничен методом/URL (NFR-07).
 */
export const buildLoggerOptions = (
  config: Pick<IAppConfig, 'nodeEnv' | 'logLevel'>,
): ILoggerOptions => {
  const base: PinoLoggerOptions = {
    level: config.logLevel,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    serializers: {
      // Только метод и URL — тела и заголовки запроса в логи не пишутся.
      req: (request: { method: string; url: string }) => ({
        method: request.method,
        url: request.url,
      }),
      res: (reply: { statusCode: number }) => ({ statusCode: reply.statusCode }),
    },
  };

  if (config.nodeEnv === 'development') {
    return {
      ...base,
      transport: {
        target: 'pino-pretty',
        options: { translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
      },
    };
  }

  return base;
};
