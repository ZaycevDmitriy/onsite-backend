import { Type } from 'typebox';

// Тело логина: учётные данные пользователя.
export const loginBodySchema = Type.Object({
  email: Type.String({ format: 'email', minLength: 3, maxLength: 320 }),
  password: Type.String({ minLength: 1, maxLength: 1024 }),
});

// Тело refresh/logout: непрозрачный refresh-токен.
export const refreshBodySchema = Type.Object({
  refreshToken: Type.String({ minLength: 1 }),
});

// Ответ с парой токенов.
export const tokenPairSchema = Type.Object({
  accessToken: Type.String(),
  refreshToken: Type.String(),
});
