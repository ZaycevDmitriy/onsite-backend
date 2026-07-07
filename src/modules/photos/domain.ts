// Чистый домен photos: без Drizzle/Fastify/AWS SDK/env (ARCHITECTURE.md).
// node:crypto — стандартная библиотека, не внешняя зависимость (решение #4 плана фазы 4).
import { createHash } from 'node:crypto';

// Допустимые MIME-типы фотоотчёта (FR-11).
export const ALLOWED_PHOTO_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type AllowedPhotoMimeType = (typeof ALLOWED_PHOTO_MIME_TYPES)[number];

/** Проверяет, что MIME-тип файла разрешён для загрузки фотоотчёта (FR-11). */
export const isAllowedMimeType = (mimeType: string): mimeType is AllowedPhotoMimeType =>
  (ALLOWED_PHOTO_MIME_TYPES as readonly string[]).includes(mimeType);

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
