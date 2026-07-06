import { AppError } from './app-error.js';
import { ErrorCodeEnum } from './error-codes.js';

import type { IErrorEnvelope } from './app-error.js';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

/**
 * Единый обработчик ошибок: всё наружу уходит конвертом { code, message, details? }.
 * - Ошибки валидации схемы: 422 validation_failed (вместо дефолтных 400 Fastify).
 * - AppError: статус и код из ошибки.
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
