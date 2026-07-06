import { randomUUID } from 'node:crypto';

import type { RawRequestDefaultExpression } from 'fastify';

// Заголовок, через который клиент может пробросить сквозной идентификатор запроса.
export const REQUEST_ID_HEADER = 'x-request-id';

// Формат UUID v1–v8: чужие значения другого формата не принимаем, чтобы не засорять логи.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Генератор requestId для Fastify (опция genReqId).
 * Валидный UUID из заголовка x-request-id пробрасывается как есть, иначе — новый UUID.
 */
export const genReqId = (req: RawRequestDefaultExpression): string => {
  const header = req.headers[REQUEST_ID_HEADER];
  const candidate = Array.isArray(header) ? header[0] : header;

  if (candidate !== undefined && UUID_PATTERN.test(candidate)) {
    return candidate;
  }

  return randomUUID();
};
