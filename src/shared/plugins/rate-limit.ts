import rateLimit from '@fastify/rate-limit';
import fp from 'fastify-plugin';

import { AppError, ErrorCodeEnum } from '@/shared/errors/index.js';

export interface IRateLimitPluginOptions {
  max: number;
  timeWindowMs: number;
}

/**
 * Глобальный rate limiting на IP (FR-18, T-17, NFR-06): keyGenerator по умолчанию — req.ip.
 * Пер-роут ужесточение — `config: { rateLimit: {...} }` (жёсткий лимит на /v1/auth/*),
 * отключение — `config: { rateLimit: false }` (health, /metrics). 429 — единый конверт ошибок,
 * не дефолтный формат плагина.
 */
export const rateLimitPlugin = fp<IRateLimitPluginOptions>(
  async (app, options) => {
    await app.register(rateLimit, {
      global: true,
      max: options.max,
      timeWindow: options.timeWindowMs,
      errorResponseBuilder: (_request, context) =>
        new AppError(context.statusCode, ErrorCodeEnum.TooManyAttempts, 'Too many requests', {
          retryAfterMs: context.ttl,
        }),
    });

    app.log.debug(
      { max: options.max, timeWindowMs: options.timeWindowMs },
      'rate-limit плагин зарегистрирован',
    );
  },
  { name: 'rate-limit' },
);
