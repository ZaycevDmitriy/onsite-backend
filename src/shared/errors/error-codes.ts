// Машиночитаемые коды ошибок API — английские константы (контракт §5.6).
export const ErrorCodeEnum = {
  ValidationFailed: 'validation_failed',
  NotFound: 'not_found',
  Unauthorized: 'unauthorized',
  Forbidden: 'forbidden',
  Conflict: 'conflict',
  InvalidTransition: 'invalid_transition',
  InvalidCredentials: 'invalid_credentials',
  TooManyAttempts: 'too_many_attempts',
  EmailTaken: 'email_taken',
  BadRequest: 'bad_request',
  InternalError: 'internal_error',
  FileTooLarge: 'file_too_large',
  UnsupportedMediaType: 'unsupported_media_type',
} as const;
export type ErrorCodeEnum = (typeof ErrorCodeEnum)[keyof typeof ErrorCodeEnum];
