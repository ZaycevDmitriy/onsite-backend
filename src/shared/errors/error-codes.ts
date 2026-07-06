// Машиночитаемые коды ошибок API — английские константы (контракт §5.6).
export const ErrorCodeEnum = {
  ValidationFailed: 'validation_failed',
  NotFound: 'not_found',
  Unauthorized: 'unauthorized',
  Forbidden: 'forbidden',
  Conflict: 'conflict',
  InvalidTransition: 'invalid_transition',
  InternalError: 'internal_error',
} as const;
export type ErrorCodeEnum = (typeof ErrorCodeEnum)[keyof typeof ErrorCodeEnum];
