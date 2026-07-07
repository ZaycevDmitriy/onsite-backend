import { Type } from 'typebox';

// Тело регистрации устройства (FR-13): формат ExpoPushToken проверяется в сервисе через
// Expo.isExpoPushToken — TypeBox лишь отсекает пустые/чрезмерно длинные значения.
export const registerDeviceBodySchema = Type.Object({
  expoPushToken: Type.String({ minLength: 1, maxLength: 512 }),
});
