import { Type } from 'typebox';

import { userViewSchema } from '@/modules/users/index.js';

// Тело логина: учётные данные пользователя.
export const loginBodySchema = Type.Object({
  email: Type.String({ format: 'email', minLength: 3, maxLength: 320 }),
  password: Type.String({ minLength: 1, maxLength: 1024 }),
});

// Тело refresh/logout: непрозрачный refresh-токен (32 случайных байта в base64url — ~43 символа,
// запас до 512 не позволяет неаутентифицированному запросу гонять по хешу многомегабайтные строки).
export const refreshBodySchema = Type.Object({
  refreshToken: Type.String({ minLength: 1, maxLength: 512 }),
});

// Ответ с парой токенов.
export const tokenPairSchema = Type.Object({
  accessToken: Type.String(),
  refreshToken: Type.String(),
});

// Ответ логина: пара токенов + профиль пользователя (§5.6 спеки).
// Type.Composite нет в typebox@1.3.4 — плоский Type.Object со spread'ом properties.
export const loginResponseSchema = Type.Object({
  ...tokenPairSchema.properties,
  user: userViewSchema,
});
