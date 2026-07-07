import { Type } from 'typebox';

import { PhotoStatusEnum } from './db-schema.js';

const photoStatusSchema = Type.Union([
  Type.Literal(PhotoStatusEnum.Staged),
  Type.Literal(PhotoStatusEnum.Committed),
]);

// Заголовок Idempotency-Key обязателен: его отсутствие — 422 от валидации схемы (решение #5).
export const uploadPhotoHeadersSchema = Type.Object({
  'idempotency-key': Type.String({ minLength: 1, maxLength: 255 }),
});

export const orderIdParamsSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
});

export const photoIdParamsSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
});

// Представление фото в ответах API: даты — ISO 8601 UTC.
export const photoViewSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  orderId: Type.String({ format: 'uuid' }),
  authorId: Type.String({ format: 'uuid' }),
  status: photoStatusSchema,
  comment: Type.Union([Type.String(), Type.Null()]),
  takenAt: Type.String({ format: 'date-time' }),
  createdAt: Type.String({ format: 'date-time' }),
});

// 302 на presigned URL: тело пустое, Location — в заголовке (см. паттерн 204 в auth/routes.ts).
export const photoFileRedirectResponseSchema = {
  type: 'null',
  description: 'Redirect на presigned URL файла фото',
  headers: {
    location: { type: 'string', format: 'uri', description: 'Presigned URL файла фото' },
  },
} as const;
