import { and, count as sqlCount, eq, isNotNull, lte } from 'drizzle-orm';

import { devices, PushOutboxStatusEnum, pushOutbox } from './db-schema.js';

import type { IOutboxTicket } from './db-schema.js';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

// Строки таблиц как их видит Drizzle.
export type IDeviceRow = typeof devices.$inferSelect;
export type IPushOutboxRow = typeof pushOutbox.$inferSelect;

// Транзакционный или обычный клиент Drizzle — enqueue вызывается внутри транзакции assignOrder.
export type DbClient = NodePgDatabase | Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0];

export interface IInsertDeviceInput {
  userId: string;
  expoPushToken: string;
}

export interface IEnqueuePushInput {
  userId: string;
  message: unknown;
}

/** Ищет устройство по expo-push-токену (токен уникален глобально). */
export const findDeviceByToken = async (
  db: DbClient,
  expoPushToken: string,
): Promise<IDeviceRow | null> => {
  const rows = await db
    .select()
    .from(devices)
    .where(eq(devices.expoPushToken, expoPushToken))
    .limit(1);

  return rows[0] ?? null;
};

/** Вставляет новое устройство. */
export const insertDevice = async (
  db: DbClient,
  input: IInsertDeviceInput,
): Promise<IDeviceRow> => {
  const rows = await db.insert(devices).values(input).returning();

  // returning() по одной записи всегда отдаёт ровно одну строку.
  return rows[0] as IDeviceRow;
};

/**
 * Перепривязывает устройство новому владельцу и реактивирует его (решение #8 фазы 6):
 * повторная регистрация того же токена — upsert, в т.ч. при смене аккаунта.
 */
export const updateDeviceOwner = async (
  db: DbClient,
  id: string,
  userId: string,
): Promise<IDeviceRow> => {
  const rows = await db
    .update(devices)
    .set({ userId, isActive: true, updatedAt: new Date() })
    .where(eq(devices.id, id))
    .returning();

  // Строка только что найдена по id этой же функцией-вызывающей: не может отсутствовать.
  return rows[0] as IDeviceRow;
};

/** Активные устройства пользователя — получатели push о назначении (FR-13/FR-14). */
export const listActiveDevicesByUserId = async (
  db: DbClient,
  userId: string,
): Promise<IDeviceRow[]> =>
  db
    .select()
    .from(devices)
    .where(and(eq(devices.userId, userId), eq(devices.isActive, true)));

/** Деактивирует устройство (Expo отдал DeviceNotRegistered — тикет или receipt, FR-13). */
export const deactivateDeviceByToken = async (
  db: DbClient,
  expoPushToken: string,
): Promise<void> => {
  await db
    .update(devices)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(devices.expoPushToken, expoPushToken));
};

/** Кладёт сообщение в outbox (вызывается внутри транзакции assignOrder, решение #3 фазы 6). */
export const enqueuePush = async (db: DbClient, input: IEnqueuePushInput): Promise<void> => {
  await db.insert(pushOutbox).values({ userId: input.userId, message: input.message });
};

/**
 * Записи outbox в статусе pending — кандидаты стадии отправки (T-16).
 * FOR UPDATE SKIP LOCKED: безопасно при 2+ инстансах worker'а (решение #2 фазы 6) — вызывается
 * внутри транзакции, конкурентный прогон пропускает уже захваченные строки, а не блокируется на них.
 */
export const listPendingOutbox = async (db: DbClient, limit: number): Promise<IPushOutboxRow[]> =>
  db
    .select()
    .from(pushOutbox)
    .where(eq(pushOutbox.status, PushOutboxStatusEnum.Pending))
    .limit(limit)
    .for('update', { skipLocked: true });

/** Помечает запись отправленной: сохраняет тикеты по каждому устройству и sent_at (стадия отправки). */
export const markOutboxSent = async (
  db: DbClient,
  id: number,
  tickets: IOutboxTicket[],
): Promise<void> => {
  await db
    .update(pushOutbox)
    .set({ status: PushOutboxStatusEnum.Sent, tickets, sentAt: new Date(), lastError: null })
    .where(eq(pushOutbox.id, id));
};

/** Инкрементит attempts и, если лимит исчерпан, помечает failed с текстом ошибки. */
export const markOutboxAttemptFailed = async (
  db: DbClient,
  row: IPushOutboxRow,
  errorMessage: string,
  maxAttempts: number,
): Promise<void> => {
  const attempts = row.attempts + 1;
  const status =
    attempts >= maxAttempts ? PushOutboxStatusEnum.Failed : PushOutboxStatusEnum.Pending;

  await db
    .update(pushOutbox)
    .set({ attempts, status, lastError: errorMessage })
    .where(eq(pushOutbox.id, row.id));
};

/** Записи в статусе sent, чьи тикеты старше порога — кандидаты стадии проверки receipt'ов. */
export const listSentOutboxOlderThan = async (
  db: DbClient,
  olderThan: Date,
  limit: number,
): Promise<IPushOutboxRow[]> =>
  db
    .select()
    .from(pushOutbox)
    .where(
      and(
        eq(pushOutbox.status, PushOutboxStatusEnum.Sent),
        isNotNull(pushOutbox.tickets),
        lte(pushOutbox.sentAt, olderThan),
      ),
    )
    .limit(limit);

/** Финализирует запись после успешного receipt'а — запись выполнила свою роль в outbox. */
export const deleteOutboxById = async (db: DbClient, id: number): Promise<void> => {
  await db.delete(pushOutbox).where(eq(pushOutbox.id, id));
};

/** Receipt вернул ошибку (не DeviceNotRegistered) — фиксируется как failed с текстом ошибки. */
export const markOutboxReceiptFailed = async (
  db: DbClient,
  id: number,
  errorMessage: string,
): Promise<void> => {
  await db
    .update(pushOutbox)
    .set({ status: PushOutboxStatusEnum.Failed, lastError: errorMessage })
    .where(eq(pushOutbox.id, id));
};

/** Глубина outbox по статусам — Gauge метрик (T-20, решение #4 фазы 6). */
export const countOutboxByStatus = async (
  db: NodePgDatabase,
): Promise<Record<PushOutboxStatusEnum, number>> => {
  const rows = await db
    .select({ status: pushOutbox.status, count: sqlCount() })
    .from(pushOutbox)
    .groupBy(pushOutbox.status);

  const counts: Record<PushOutboxStatusEnum, number> = {
    [PushOutboxStatusEnum.Pending]: 0,
    [PushOutboxStatusEnum.Sent]: 0,
    [PushOutboxStatusEnum.Failed]: 0,
  };

  for (const row of rows) {
    counts[row.status] = Number(row.count);
  }

  return counts;
};
