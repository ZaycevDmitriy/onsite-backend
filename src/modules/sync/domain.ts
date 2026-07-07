// Чистый домен sync: без Drizzle/Fastify/AWS SDK/env (ARCHITECTURE.md).

// Элемент pull-страницы: изменённая заявка техника.
export interface ISyncOrderPullItem<TOrder> {
  type: 'order';
  seq: number;
  order: TOrder;
}

// Элемент pull-страницы: tombstone снятого/переназначенного назначения (§5.5).
export interface ISyncUnassignedPullItem {
  type: 'unassigned';
  seq: number;
  orderId: string;
}

export type ISyncPullItem<TOrder> = ISyncOrderPullItem<TOrder> | ISyncUnassignedPullItem;

export interface IBuildSyncPageInput<TOrder> {
  // Оба потока предполагаются уже отсортированными по seq и выбранными с LIMIT limit+1.
  orderItems: ISyncOrderPullItem<TOrder>[];
  tombstoneItems: ISyncUnassignedPullItem[];
  limit: number;
  cursor: number;
  // Текущее максимальное значение общей последовательности sync_seq на момент запроса.
  currentMaxSeq: number;
  safetyLag: number;
}

export interface IBuildSyncPageResult<TOrder> {
  items: ISyncPullItem<TOrder>[];
  nextCursor: number;
}

/**
 * Сливает два потока (заявки по updated_seq, tombstone по unassigned_seq) в один список,
 * упорядоченный по общей последовательности sync_seq (решение #2 фазы 5).
 * Совпадение seq между потоками невозможно — оба берут значения из одной sync_seq.
 */
export const mergeSyncStreams = <TOrder>(
  orderItems: ISyncOrderPullItem<TOrder>[],
  tombstoneItems: ISyncUnassignedPullItem[],
): ISyncPullItem<TOrder>[] =>
  [...orderItems, ...tombstoneItems].sort((a, b) => a.seq - b.seq);

/**
 * Курсор следующей страницы pull (FR-08, NFR-08, решение #1 фазы 5):
 * - страница неполная (не набрала limit) → nextCursor = max(0, currentMaxSeq - safetyLag),
 *   повторная выдача хвоста при конкурентных незакоммиченных транзакциях допустима (pull идемпотентен);
 * - страница полная (есть ещё данные) → nextCursor = seq последнего элемента страницы;
 * - пустая страница → nextCursor не двигается (остаётся cursor).
 */
export const computeNextCursor = <TOrder>(input: {
  page: ISyncPullItem<TOrder>[];
  hasMore: boolean;
  cursor: number;
  currentMaxSeq: number;
  safetyLag: number;
}): number => {
  const lastItem = input.page[input.page.length - 1];

  if (lastItem === undefined) {
    return input.cursor;
  }

  if (input.hasMore) {
    return lastItem.seq;
  }

  return Math.max(0, input.currentMaxSeq - input.safetyLag);
};

/** Собирает страницу pull: слияние потоков → ограничение до limit → курсор (решение #1, #2 фазы 5). */
export const buildSyncPage = <TOrder>(
  input: IBuildSyncPageInput<TOrder>,
): IBuildSyncPageResult<TOrder> => {
  const merged = mergeSyncStreams(input.orderItems, input.tombstoneItems);
  const hasMore = merged.length > input.limit;
  const page = hasMore ? merged.slice(0, input.limit) : merged;
  const nextCursor = computeNextCursor({
    page,
    hasMore,
    cursor: input.cursor,
    currentMaxSeq: input.currentMaxSeq,
    safetyLag: input.safetyLag,
  });

  return { items: page, nextCursor };
};
