import { Type } from 'typebox';

import { ServiceOrderStatusEnum } from '@/modules/orders/index.js';
import { PhotoStatusEnum } from '@/modules/photos/index.js';

const orderStatusSchema = Type.Union([
  Type.Literal(ServiceOrderStatusEnum.New),
  Type.Literal(ServiceOrderStatusEnum.InProgress),
  Type.Literal(ServiceOrderStatusEnum.Done),
  Type.Literal(ServiceOrderStatusEnum.Cancelled),
]);

// Фото в pull-снимке заявки: контракт принадлежит sync, мирроринг IPhotoView — без импорта схемы
// из photos, тот же принцип, что и у orders/schemas.ts (решение #16 фазы 4).
const syncPhotoSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  orderId: Type.String({ format: 'uuid' }),
  authorId: Type.String({ format: 'uuid' }),
  status: Type.Union([
    Type.Literal(PhotoStatusEnum.Staged),
    Type.Literal(PhotoStatusEnum.Committed),
  ]),
  comment: Type.Union([Type.String(), Type.Null()]),
  takenAt: Type.String({ format: 'date-time' }),
  createdAt: Type.String({ format: 'date-time' }),
});

// Заявка в pull-элементе: контракт принадлежит sync, мирроринг IOrderView + committed-фото.
const syncOrderPayloadSchema = Type.Object({
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
  photos: Type.Array(syncPhotoSchema),
});

// Дискриминированный элемент pull-страницы по type (решение #2 фазы 5).
const syncPullOrderItemSchema = Type.Object({
  type: Type.Literal('order'),
  seq: Type.Integer(),
  order: syncOrderPayloadSchema,
});

const syncPullUnassignedItemSchema = Type.Object({
  type: Type.Literal('unassigned'),
  seq: Type.Integer(),
  orderId: Type.String({ format: 'uuid' }),
});

const syncPullItemSchema = Type.Union([syncPullOrderItemSchema, syncPullUnassignedItemSchema]);

// Курсор — bigint в БД, но в пределах Number.MAX_SAFE_INTEGER для портфолио-объёмов (решение #9 фазы 5).
export const syncPullQuerySchema = Type.Object({
  cursor: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
});

export const syncPullResponseSchema = Type.Object({
  items: Type.Array(syncPullItemSchema),
  nextCursor: Type.Integer({ minimum: 0 }),
});
