// Чистый домен photos: без Drizzle/Fastify/AWS SDK/env (ARCHITECTURE.md).
// node:crypto — стандартная библиотека, не внешняя зависимость (решение #4 плана фазы 4).
import { createHash } from 'node:crypto';

// Допустимые MIME-типы фотоотчёта (FR-11).
export const ALLOWED_PHOTO_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type AllowedPhotoMimeType = (typeof ALLOWED_PHOTO_MIME_TYPES)[number];

/** Проверяет, что MIME-тип файла разрешён для загрузки фотоотчёта (FR-11). */
export const isAllowedMimeType = (mimeType: string): mimeType is AllowedPhotoMimeType =>
  (ALLOWED_PHOTO_MIME_TYPES as readonly string[]).includes(mimeType);

// Максимальная длина комментария к фото: multipart-поля минуют TypeBox-валидацию тела.
export const PHOTO_COMMENT_MAX_LENGTH = 2000;

const startsWithBytes = (bytes: Uint8Array, prefix: number[], offset = 0): boolean =>
  prefix.every((byte, index) => bytes[offset + index] === byte);

// Магические байты допустимых форматов: JPEG (FF D8 FF), PNG (89 PNG..), WebP (RIFF....WEBP).
const MAGIC_BYTE_CHECKS: Record<AllowedPhotoMimeType, (bytes: Uint8Array) => boolean> = {
  'image/jpeg': (bytes) => startsWithBytes(bytes, [0xff, 0xd8, 0xff]),
  'image/png': (bytes) => startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/webp': (bytes) =>
    startsWithBytes(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWithBytes(bytes, [0x57, 0x45, 0x42, 0x50], 8),
};

/**
 * Сверяет заявленный MIME-тип с магическими байтами содержимого:
 * заголовок multipart контролируется клиентом и сам по себе не доказывает формат файла.
 */
export const matchesDeclaredMimeType = (
  bytes: Uint8Array,
  mimeType: AllowedPhotoMimeType,
): boolean => MAGIC_BYTE_CHECKS[mimeType](bytes);

/**
 * Строит детерминированный storage_key для идемпотентной загрузки (решение #1):
 * orders/<orderId>/<sha256(authorId + ':' + idempotencyKey)>.
 * Один и тот же Idempotency-Key разных авторов или в разных заявках даёт разные ключи.
 */
export const buildStorageKey = (
  orderId: string,
  authorId: string,
  idempotencyKey: string,
): string => {
  const hash = createHash('sha256').update(`${authorId}:${idempotencyKey}`).digest('hex');

  return `orders/${orderId}/${hash}`;
};

const MS_PER_HOUR = 3_600_000;

/** Считается ли staged-фото сиротой, подлежащим зачистке (T-13): старше ttlHours от createdAt. */
export const isStagedExpired = (createdAt: Date, now: Date, ttlHours: number): boolean =>
  now.getTime() - createdAt.getTime() > ttlHours * MS_PER_HOUR;
