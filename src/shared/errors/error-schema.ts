import { Type } from 'typebox';

import { ErrorCodeEnum } from './error-codes.js';

// TypeBox-схема единого конверта ошибок для response-схем роутов (§5.6).
export const errorEnvelopeSchema = Type.Object({
  code: Type.Union(Object.values(ErrorCodeEnum).map((code) => Type.Literal(code))),
  message: Type.String(),
  details: Type.Optional(Type.Unknown()),
});
