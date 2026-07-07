import { describe, expect, it } from 'vitest';

import { buildSyncPage, computeNextCursor, mergeSyncStreams } from '../domain.js';

import type { ISyncOrderPullItem, ISyncUnassignedPullItem } from '../domain.js';

const orderItem = (seq: number): ISyncOrderPullItem<{ id: string }> => ({
  type: 'order',
  seq,
  order: { id: `order-${seq}` },
});

const tombstoneItem = (seq: number): ISyncUnassignedPullItem => ({
  type: 'unassigned',
  seq,
  orderId: `order-${seq}`,
});

describe('mergeSyncStreams', () => {
  it('сливает два потока в единый список, упорядоченный по seq', () => {
    const merged = mergeSyncStreams([orderItem(1), orderItem(4)], [tombstoneItem(2), tombstoneItem(3)]);

    expect(merged.map((item) => item.seq)).toEqual([1, 2, 3, 4]);
    expect(merged.map((item) => item.type)).toEqual(['order', 'unassigned', 'unassigned', 'order']);
  });

  it('пустые потоки → пустой результат', () => {
    expect(mergeSyncStreams([], [])).toEqual([]);
  });

  it('один поток пуст — результат равен второму, отсортированному по seq', () => {
    const merged = mergeSyncStreams([orderItem(5), orderItem(1)], []);

    expect(merged.map((item) => item.seq)).toEqual([1, 5]);
  });
});

describe('computeNextCursor', () => {
  it('пустая страница → курсор не двигается', () => {
    const cursor = computeNextCursor({ page: [], hasMore: false, cursor: 42, currentMaxSeq: 100, safetyLag: 10 });

    expect(cursor).toBe(42);
  });

  it('есть ещё данные (hasMore) → курсор = seq последнего элемента страницы', () => {
    const page = [orderItem(5), orderItem(9)];
    const cursor = computeNextCursor({ page, hasMore: true, cursor: 0, currentMaxSeq: 9, safetyLag: 100 });

    expect(cursor).toBe(9);
  });

  it('страница неполная (данных больше нет) → курсор = max(0, currentMaxSeq - safetyLag)', () => {
    const page = [orderItem(5)];
    const cursor = computeNextCursor({ page, hasMore: false, cursor: 0, currentMaxSeq: 150, safetyLag: 100 });

    expect(cursor).toBe(50);
  });

  it('safetyLag больше currentMaxSeq → курсор не уходит в отрицательные значения', () => {
    const page = [orderItem(5)];
    const cursor = computeNextCursor({ page, hasMore: false, cursor: 0, currentMaxSeq: 30, safetyLag: 100 });

    expect(cursor).toBe(0);
  });
});

describe('buildSyncPage', () => {
  it('ограничивает страницу limit и корректно считает hasMore/nextCursor', () => {
    const result = buildSyncPage({
      orderItems: [orderItem(1), orderItem(3), orderItem(5)],
      tombstoneItems: [tombstoneItem(2), tombstoneItem(4)],
      limit: 3,
      cursor: 0,
      currentMaxSeq: 5,
      safetyLag: 100,
    });

    expect(result.items.map((item) => item.seq)).toEqual([1, 2, 3]);
    expect(result.nextCursor).toBe(3);
  });

  it('данных меньше limit — вся страница отдаётся, курсор с safety-lag', () => {
    const result = buildSyncPage({
      orderItems: [orderItem(1)],
      tombstoneItems: [tombstoneItem(2)],
      limit: 200,
      cursor: 0,
      currentMaxSeq: 300,
      safetyLag: 100,
    });

    expect(result.items.map((item) => item.seq)).toEqual([1, 2]);
    expect(result.nextCursor).toBe(200);
  });

  it('пустые потоки → пустая страница, курсор не двигается', () => {
    const result = buildSyncPage({
      orderItems: [],
      tombstoneItems: [],
      limit: 200,
      cursor: 17,
      currentMaxSeq: 500,
      safetyLag: 100,
    });

    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBe(17);
  });
});
