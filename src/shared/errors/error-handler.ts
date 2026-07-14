import { AppError } from './app-error.js';
import { ErrorCodeEnum } from './error-codes.js';

import type { IErrorEnvelope } from './app-error.js';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

// Коды для собственных 4xx-ошибок Fastify по их статусу; остальные 4xx — bad_request.
const FASTIFY_CLIENT_ERROR_CODES: Record<number, ErrorCodeEnum> = {
  413: ErrorCodeEnum.FileTooLarge,
  415: ErrorCodeEnum.UnsupportedMediaType,
};

/**
 * Единый обработчик ошибок: всё наружу уходит конвертом { code, message, details? }.
 * - Ошибки валидации схемы: 422 validation_failed (вместо дефолтных 400 Fastify).
 * - AppError: статус и код из ошибки.
 * - Собственные 4xx Fastify (битый JSON, body сверх лимита, неверный content-type):
 *   родной статус и конверт — клиентская ошибка не маскируется под 500 и не шумит в 5xx-метрике.
 * - Остальное: 500 internal_error, stack — только в лог, не в ответ.
 */
export const errorHandler = (
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): void => {
  if (error.validation) {
    const envelope: IErrorEnvelope = {
      code: ErrorCodeEnum.ValidationFailed,
      message: 'Request validation failed',
      details: error.validation.map((issue) => ({
        path: issue.instancePath || '/',
        message: issue.message ?? 'invalid value',
      })),
    };

    request.log.debug({ requestId: request.id, issues: envelope.details }, 'validation failed');
    void reply.status(422).send(envelope);
    return;
  }

  if (error instanceof AppError) {
    request.log.info(
      { requestId: request.id, code: error.code, statusCode: error.statusCode },
      'application error',
    );
    void reply.status(error.statusCode).send(error.toEnvelope());
    return;
  }

  // Ошибки со статусом 4xx: статус сохраняется (клиентская ошибка не маскируется под 500).
  // Префикс FST_ покрывает собственные ошибки Fastify и плагины экосистемы на @fastify/error
  // (например @fastify/multipart): их сообщения рассчитаны на клиента и уходят наружу.
  // Сообщения прочих библиотек могут содержать внутренние детали — им отдаётся статичный текст.
  if (typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500) {
    const isFastifyEcosystemError = typeof error.code === 'string' && error.code.startsWith('FST_');

    if (isFastifyEcosystemError) {
      request.log.info(
        { requestId: request.id, fastifyCode: error.code, statusCode: error.statusCode },
        'client error',
      );
    } else {
      // Warn без объекта ошибки: сторонний 4xx — редкость, достойная внимания, но stack
      // на каждый такой запрос в логах не нужен; code и message достаточно для диагностики.
      request.log.warn(
        {
          requestId: request.id,
          errorCode: error.code,
          errorMessage: error.message,
          statusCode: error.statusCode,
        },
        'client error (message masked)',
      );
    }
    void reply.status(error.statusCode).send({
      code: FASTIFY_CLIENT_ERROR_CODES[error.statusCode] ?? ErrorCodeEnum.BadRequest,
      message: isFastifyEcosystemError ? error.message : 'Request cannot be processed',
    } satisfies IErrorEnvelope);
    return;
  }

  // Неожиданная ошибка: stack в лог с requestId, наружу — обезличенный конверт.
  request.log.error({ requestId: request.id, err: error }, 'unhandled error');
  void reply.status(500).send({
    code: ErrorCodeEnum.InternalError,
    message: 'Internal server error',
  } satisfies IErrorEnvelope);
};

/**
 * Обработчик неизвестных маршрутов: тот же конверт, код not_found.
 */
export const notFoundHandler = (request: FastifyRequest, reply: FastifyReply): void => {
  void reply.status(404).send({
    code: ErrorCodeEnum.NotFound,
    message: 'Route not found',
  } satisfies IErrorEnvelope);
};
