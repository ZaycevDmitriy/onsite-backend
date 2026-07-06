import { Type } from 'typebox';

import { UserRoleEnum } from './db-schema.js';

const roleSchema = Type.Union([
  Type.Literal(UserRoleEnum.Dispatcher),
  Type.Literal(UserRoleEnum.Technician),
]);

// Тело создания пользователя (только диспетчер).
export const createUserBodySchema = Type.Object({
  email: Type.String({ format: 'email', minLength: 3, maxLength: 320 }),
  password: Type.String({ minLength: 8, maxLength: 1024 }),
  role: roleSchema,
  displayName: Type.String({ minLength: 1, maxLength: 200 }),
});

// Тело обновления: displayName, деактивация, сброс пароля.
export const updateUserBodySchema = Type.Object(
  {
    displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    isActive: Type.Optional(Type.Boolean()),
    password: Type.Optional(Type.String({ minLength: 8, maxLength: 1024 })),
  },
  { minProperties: 1 },
);

export const userIdParamsSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
});

// Представление пользователя в ответах: без passwordHash.
export const userViewSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  email: Type.String(),
  role: roleSchema,
  displayName: Type.String(),
  isActive: Type.Boolean(),
  createdAt: Type.String({ format: 'date-time' }),
});
