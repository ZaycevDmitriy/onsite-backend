import type { ErrorCodeEnum } from './error-codes.js';

// Единый конверт ошибок API: { code, message, details? } (§5.6).
export interface IErrorEnvelope {
  code: ErrorCodeEnum;
  message: string;
  details?: unknown;
}

/**
 * Прикладная ошибка с HTTP-статусом и машиночитаемым кодом.
 * Сервисы бросают её, error handler превращает в конверт.
 */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: ErrorCodeEnum,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }

  toEnvelope(): IErrorEnvelope {
    const envelope: IErrorEnvelope = { code: this.code, message: this.message };

    if (this.details !== undefined) {
      envelope.details = this.details;
    }

    return envelope;
  }
}
