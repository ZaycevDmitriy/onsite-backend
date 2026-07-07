// Чистый домен заявок: без Drizzle/Fastify/AWS SDK/env (ARCHITECTURE.md).

// Статусы заявки — зеркало клиентского ServiceOrderStatusEnum.
export const ServiceOrderStatusEnum = {
  New: 'New',
  InProgress: 'InProgress',
  Done: 'Done',
  Cancelled: 'Cancelled',
} as const;
export type ServiceOrderStatusEnum =
  (typeof ServiceOrderStatusEnum)[keyof typeof ServiceOrderStatusEnum];

// Матрица переходов статусов (FR-07) — единственный источник истины, зеркало клиентских guard'ов.
export const ORDER_TRANSITIONS: Record<ServiceOrderStatusEnum, readonly ServiceOrderStatusEnum[]> =
  {
    [ServiceOrderStatusEnum.New]: [
      ServiceOrderStatusEnum.InProgress,
      ServiceOrderStatusEnum.Cancelled,
    ],
    [ServiceOrderStatusEnum.InProgress]: [
      ServiceOrderStatusEnum.Done,
      ServiceOrderStatusEnum.Cancelled,
    ],
    [ServiceOrderStatusEnum.Done]: [],
    [ServiceOrderStatusEnum.Cancelled]: [],
  };

/** Допустим ли переход статуса заявки (FR-07). */
export const canTransition = (from: ServiceOrderStatusEnum, to: ServiceOrderStatusEnum): boolean =>
  ORDER_TRANSITIONS[from].includes(to);

// Статусы, при которых заявку можно назначить/переназначить (FR-06).
export const ASSIGNABLE_STATUSES: readonly ServiceOrderStatusEnum[] = [
  ServiceOrderStatusEnum.New,
  ServiceOrderStatusEnum.InProgress,
];

/** Допустимо ли назначение/переназначение техника при текущем статусе заявки (FR-06). */
export const canAssign = (status: ServiceOrderStatusEnum): boolean =>
  ASSIGNABLE_STATUSES.includes(status);
