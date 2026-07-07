import { describe, expect, it } from 'vitest';

import {
  ALLOWED_PHOTO_MIME_TYPES,
  buildStorageKey,
  isAllowedMimeType,
  isStagedExpired,
  matchesDeclaredMimeType,
} from '../domain.js';

describe('buildStorageKey', () => {
  const orderId = '11111111-1111-1111-1111-111111111111';
  const authorId = '22222222-2222-2222-2222-222222222222';
  const idempotencyKey = 'client-key-1';

  it('детерминирован: одинаковые входные данные дают одинаковый ключ', () => {
    const first = buildStorageKey(orderId, authorId, idempotencyKey);
    const second = buildStorageKey(orderId, authorId, idempotencyKey);

    expect(first).toBe(second);
  });

  it('начинается с orders/<orderId>/', () => {
    const key = buildStorageKey(orderId, authorId, idempotencyKey);

    expect(key).toMatch(new RegExp(`^orders/${orderId}/[0-9a-f]{64}$`));
  });

  it('различается при другом orderId', () => {
    const other = buildStorageKey('33333333-3333-3333-3333-333333333333', authorId, idempotencyKey);
    const base = buildStorageKey(orderId, authorId, idempotencyKey);

    expect(other).not.toBe(base);
  });

  it('различается при другом authorId', () => {
    const other = buildStorageKey(orderId, '44444444-4444-4444-4444-444444444444', idempotencyKey);
    const base = buildStorageKey(orderId, authorId, idempotencyKey);

    expect(other).not.toBe(base);
  });

  it('различается при другом idempotencyKey', () => {
    const other = buildStorageKey(orderId, authorId, 'client-key-2');
    const base = buildStorageKey(orderId, authorId, idempotencyKey);

    expect(other).not.toBe(base);
  });
});

describe('isAllowedMimeType', () => {
  for (const mimeType of ALLOWED_PHOTO_MIME_TYPES) {
    it(`${mimeType} → разрешён`, () => {
      expect(isAllowedMimeType(mimeType)).toBe(true);
    });
  }

  it('application/pdf → запрещён', () => {
    expect(isAllowedMimeType('application/pdf')).toBe(false);
  });

  it('image/gif → запрещён', () => {
    expect(isAllowedMimeType('image/gif')).toBe(false);
  });

  it('пустая строка → запрещена', () => {
    expect(isAllowedMimeType('')).toBe(false);
  });
});

describe('matchesDeclaredMimeType', () => {
  const jpegBytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const pngBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  const webpBytes = Uint8Array.from([
    0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38,
  ]);

  it('JPEG-байты соответствуют image/jpeg', () => {
    expect(matchesDeclaredMimeType(jpegBytes, 'image/jpeg')).toBe(true);
  });

  it('PNG-байты соответствуют image/png', () => {
    expect(matchesDeclaredMimeType(pngBytes, 'image/png')).toBe(true);
  });

  it('WebP-байты соответствуют image/webp', () => {
    expect(matchesDeclaredMimeType(webpBytes, 'image/webp')).toBe(true);
  });

  it('PNG-байты не соответствуют image/jpeg', () => {
    expect(matchesDeclaredMimeType(pngBytes, 'image/jpeg')).toBe(false);
  });

  it('произвольный текст не соответствует ни одному типу', () => {
    const textBytes = new TextEncoder().encode('просто текст');

    for (const mimeType of ALLOWED_PHOTO_MIME_TYPES) {
      expect(matchesDeclaredMimeType(textBytes, mimeType)).toBe(false);
    }
  });

  it('RIFF без сигнатуры WEBP не соответствует image/webp', () => {
    const riffOnly = Uint8Array.from([
      0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x41, 0x56, 0x49, 0x20,
    ]);

    expect(matchesDeclaredMimeType(riffOnly, 'image/webp')).toBe(false);
  });

  it('пустой буфер не соответствует ни одному типу', () => {
    for (const mimeType of ALLOWED_PHOTO_MIME_TYPES) {
      expect(matchesDeclaredMimeType(new Uint8Array(0), mimeType)).toBe(false);
    }
  });
});

describe('isStagedExpired', () => {
  const createdAt = new Date('2026-01-01T00:00:00.000Z');
  const ttlHours = 168;

  it('свежее фото (0 часов) — не истекло', () => {
    expect(isStagedExpired(createdAt, createdAt, ttlHours)).toBe(false);
  });

  it('ровно на границе TTL — ещё не истекло', () => {
    const now = new Date(createdAt.getTime() + ttlHours * 3_600_000);

    expect(isStagedExpired(createdAt, now, ttlHours)).toBe(false);
  });

  it('на 1 мс старше границы TTL — истекло', () => {
    const now = new Date(createdAt.getTime() + ttlHours * 3_600_000 + 1);

    expect(isStagedExpired(createdAt, now, ttlHours)).toBe(true);
  });

  it('значительно старше TTL — истекло', () => {
    const now = new Date(createdAt.getTime() + (ttlHours + 24) * 3_600_000);

    expect(isStagedExpired(createdAt, now, ttlHours)).toBe(true);
  });
});
