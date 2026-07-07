import { Type } from 'typebox';

import { OrderEventTypeEnum } from './db-schema.js';
import { ServiceOrderStatusEnum } from './domain.js';

// Nullable-число для тел запросов: type: ['number','null'] вместо anyOf —
// AJV с coerceTypes в anyOf коэрсит null в 0 по первой ветке, с массивом типов — нет.
const nullableNumberSchema = (minimum: number, maximum: number) =>
  Type.Unsafe<number | null>({ type: ['number', 'null'], minimum, maximum });

const orderStatusSchema = Type.Union([
  Type.Literal(ServiceOrderStatusEnum.New),
  Type.Literal(ServiceOrderStatusEnum.InProgress),
  Type.Literal(ServiceOrderStatusEnum.Done),
  Type.Literal(ServiceOrderStatusEnum.Cancelled),
]);

const orderEventTypeSchema = Type.Union([
  Type.Literal(OrderEventTypeEnum.Created),
  Type.Literal(OrderEventTypeEnum.Assigned),
  Type.Literal(OrderEventTypeEnum.StatusChanged),
  Type.Literal(OrderEventTypeEnum.PhotoAdded),
  Type.Literal(OrderEventTypeEnum.SyncConflict),
]);

// Общие поля заявки, переиспользуются в теле создания/правки (FR-05).
const orderFieldsSchema = {
  title: Type.String({ minLength: 1, maxLength: 200 }),
  client: Type.String({ minLength: 1, maxLength: 200 }),
  address: Type.String({ minLength: 1, maxLength: 500 }),
  description: Type.String({ minLength: 1, maxLength: 5000 }),
  scheduledAt: Type.String({ format: 'date-time' }),
  slotStart: Type.String({ format: 'date-time' }),
  slotEnd: Type.String({ format: 'date-time' }),
  latitude: Type.Optional(Type.Number({ minimum: -90, maximum: 90 })),
  longitude: Type.Optional(Type.Number({ minimum: -180, maximum: 180 })),
};

// Тело создания заявки (dispatcher, FR-05).
export const createOrderBodySchema = Type.Object(orderFieldsSchema);

// Тело правки полей заявки: статус меняется только через transition (решение #8).
export const updateOrderBodySchema = Type.Object(
  {
    title: Type.Optional(orderFieldsSchema.title),
    client: Type.Optional(orderFieldsSchema.client),
    address: Type.Optional(orderFieldsSchema.address),
    description: Type.Optional(orderFieldsSchema.description),
    scheduledAt: Type.Optional(orderFieldsSchema.scheduledAt),
    slotStart: Type.Optional(orderFieldsSchema.slotStart),
    slotEnd: Type.Optional(orderFieldsSchema.slotEnd),
    // null снимает координату: заявку можно «убрать с карты».
    latitude: Type.Optional(nullableNumberSchema(-90, 90)),
    longitude: Type.Optional(nullableNumberSchema(-180, 180)),
  },
  { minProperties: 1 },
);

// Тело назначения/переназначения техника (dispatcher, FR-06).
export const assignOrderBodySchema = Type.Object({
  technicianId: Type.String({ format: 'uuid' }),
});

// Тело перехода статуса: baseStatus — снимок клиента для конфликт-детекции (FR-07).
export const transitionOrderBodySchema = Type.Object({
  to: orderStatusSchema,
  baseStatus: orderStatusSchema,
});

export const orderIdParamsSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
});

// Query списка заявок: у technician assignedTo игнорируется — только свои (решение #9).
export const listOrdersQuerySchema = Type.Object({
  status: Type.Optional(orderStatusSchema),
  assignedTo: Type.Optional(Type.String({ format: 'uuid' })),
  cursor: Type.Optional(Type.String({ minLength: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
});

// Представление заявки в ответах API.
export const orderViewSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  status: orderStatusSchema,
  title: Type.String(),
  client: Type.String(),
  address: Type.String(),
  description: Type.String(),
  scheduledAt: Type.String({ format: 'date-time' }),
  slotStart: Type.String({ format: 'date-time' }),
  slotEnd: Type.String({ format: 'date-time' }),
  latitude: Type.Union([Type.Number(), Type.Null()]),
  longitude: Type.Union([Type.Number(), Type.Null()]),
  assignedTo: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  updatedSeq: Type.Integer(),
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
});

// Фото в детальном ответе заявки: контракт принадлежит orders, не импортируется из photos —
// иначе ESM-цикл photos ↔ orders (решение #16).
const orderPhotoSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  orderId: Type.String({ format: 'uuid' }),
  authorId: Type.String({ format: 'uuid' }),
  status: Type.Union([Type.Literal('staged'), Type.Literal('committed')]),
  comment: Type.Union([Type.String(), Type.Null()]),
  takenAt: Type.String({ format: 'date-time' }),
  createdAt: Type.String({ format: 'date-time' }),
});

// Событие журнала заявки (FR-15).
export const orderEventSchema = Type.Object({
  id: Type.Integer(),
  actorId: Type.String({ format: 'uuid' }),
  type: orderEventTypeSchema,
  payload: Type.Unknown(),
  source: Type.Union([Type.Literal('api'), Type.Literal('sync')]),
  createdAt: Type.String({ format: 'date-time' }),
});

// Детальный ответ GET /v1/orders/:id: заявка + фото + события (решение #4, #10).
export const orderDetailSchema = Type.Object({
  ...orderViewSchema.properties,
  photos: Type.Array(orderPhotoSchema),
  events: Type.Array(orderEventSchema),
});

// Ответ списка: keyset-пагинация по (createdAt, id) (решение #5).
export const listOrdersResponseSchema = Type.Object({
  items: Type.Array(orderViewSchema),
  nextCursor: Type.Union([Type.String(), Type.Null()]),
});
