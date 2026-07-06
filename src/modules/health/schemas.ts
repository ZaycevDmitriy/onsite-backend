import { Type } from 'typebox';

// Статусы зависимости в ответе health.
export const DepStatusEnum = {
  Ok: 'ok',
  Unavailable: 'unavailable',
} as const;
export type DepStatusEnum = (typeof DepStatusEnum)[keyof typeof DepStatusEnum];

// Итоговый статус сервиса.
export const HealthStatusEnum = {
  Ok: 'ok',
  Degraded: 'degraded',
} as const;
export type HealthStatusEnum = (typeof HealthStatusEnum)[keyof typeof HealthStatusEnum];

export const healthResponseSchema = Type.Object({
  status: Type.Union([Type.Literal(HealthStatusEnum.Ok), Type.Literal(HealthStatusEnum.Degraded)]),
  deps: Type.Object({
    db: Type.Union([Type.Literal(DepStatusEnum.Ok), Type.Literal(DepStatusEnum.Unavailable)]),
  }),
});
