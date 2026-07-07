import { Expo } from 'expo-server-sdk';

import {
  deactivateDeviceByToken,
  deleteOutboxById,
  listActiveDevicesByUserId,
  listPendingOutbox,
  listSentOutboxOlderThan,
  markOutboxAttemptFailed,
  markOutboxReceiptFailed,
  markOutboxSent,
} from './repository.js';

import type { IDeviceRow, IPushOutboxRow } from './repository.js';
import type { ExpoPushMessage, ExpoPushReceipt, ExpoPushTicket } from 'expo-server-sdk';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { FastifyBaseLogger } from 'fastify';
import type { IOutboxTicket } from './db-schema.js';

// Тонкий интерфейс поверх Expo SDK (решение исходного плана): реальный `new Expo(...)` подходит
// структурно без обёртки, тесты подставляют фейк — воркер не тянет сетевой клиент в юнит-тесты.
export interface IExpoClient {
  sendPushNotificationsAsync(messages: ExpoPushMessage[]): Promise<ExpoPushTicket[]>;
  getPushNotificationReceiptsAsync(
    receiptIds: string[],
  ): Promise<Record<string, ExpoPushReceipt>>;
}

export interface IPushWorkerOptions {
  // Сколько записей outbox забирать за один прогон стадии отправки.
  batchLimit: number;
  maxAttempts: number;
}

export interface IPushSendResult {
  sent: number;
  failed: number;
}

export interface IPushReceiptStageOptions {
  // Сколько записей outbox забирать за один прогон стадии receipt'ов.
  batchLimit: number;
  // Минимальный возраст тикета перед проверкой receipt'а (рекомендация Expo — ~15 мин).
  receiptDelayMin: number;
}

export interface IPushReceiptResult {
  finalized: number;
  failed: number;
  // Receipt ещё не готов на стороне Expo — строка остаётся sent до следующего прогона.
  pending: number;
}

interface IPushMessagePayload {
  title?: string;
  body?: string;
  data?: Record<string, unknown>;
}

const chunkArray = <T,>(items: T[], size: number): T[][] => {
  const chunks: T[][] = [];

  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }

  return chunks;
};

/** Отправляет сообщения чанками по лимиту Expo (≤ 100/запрос); тикеты возвращаются 1:1 с messages. */
const sendAllMessages = async (
  expoClient: IExpoClient,
  messages: ExpoPushMessage[],
): Promise<ExpoPushTicket[]> => {
  const chunks = chunkArray(messages, Expo.pushNotificationChunkSizeLimit);
  const tickets: ExpoPushTicket[] = [];

  for (const chunk of chunks) {
    const chunkTickets = await expoClient.sendPushNotificationsAsync(chunk);
    tickets.push(...chunkTickets);
  }

  return tickets;
};

/** Ссылка на конкретное (outbox row, устройство), которой соответствует сообщение/тикет по индексу. */
interface IMessageRef {
  row: IPushOutboxRow;
  device: IDeviceRow;
}

/**
 * Стадия отправки push-worker'а (T-16, решение #2 фазы 6): pending → чанки Expo → tickets.
 * Один outbox row адресован userId — fan-out на все активные устройства (FR-13): каждому токену
 * отдельное сообщение (Expo возвращает тикет на каждый), успешные тикеты сохраняются на строку,
 * DeviceNotRegistered деактивирует токен немедленно (не дожидаясь receipt'а).
 * FOR UPDATE SKIP LOCKED (внутри listPendingOutbox) — безопасно при 2+ инстансах worker'а.
 */
export const runPushSendStage = async (
  db: NodePgDatabase,
  expoClient: IExpoClient,
  options: IPushWorkerOptions,
  logger: FastifyBaseLogger,
): Promise<IPushSendResult> =>
  db.transaction(async (tx) => {
    const rows = await listPendingOutbox(tx, options.batchLimit);

    if (rows.length === 0) {
      return { sent: 0, failed: 0 };
    }

    logger.debug({ count: rows.length }, 'push-worker: отправка — забраны кандидаты');

    const deviceLists = new Map<number, IDeviceRow[]>();
    const refs: IMessageRef[] = [];
    const messages: ExpoPushMessage[] = [];

    for (const row of rows) {
      const activeDevices = await listActiveDevicesByUserId(tx, row.userId);
      deviceLists.set(row.id, activeDevices);

      const payload = row.message as IPushMessagePayload;

      for (const device of activeDevices) {
        refs.push({ row, device });
        messages.push({
          to: device.expoPushToken,
          ...(payload.title !== undefined ? { title: payload.title } : {}),
          ...(payload.body !== undefined ? { body: payload.body } : {}),
          ...(payload.data !== undefined ? { data: payload.data } : {}),
        });
      }
    }

    let tickets: ExpoPushTicket[] = [];
    let sendError: unknown = null;

    if (messages.length > 0) {
      try {
        tickets = await sendAllMessages(expoClient, messages);
      } catch (error) {
        sendError = error;
        logger.warn({ err: error }, 'push-worker: запрос к Expo завершился ошибкой');
      }
    }

    const successByRowId = new Map<number, IOutboxTicket[]>();

    if (sendError === null) {
      for (const [index, ref] of refs.entries()) {
        const ticket = tickets[index];

        if (ticket === undefined) {
          continue;
        }

        if (ticket.status === 'ok') {
          const list = successByRowId.get(ref.row.id) ?? [];
          list.push({ token: ref.device.expoPushToken, ticketId: ticket.id });
          successByRowId.set(ref.row.id, list);
          continue;
        }

        if (ticket.details?.error === 'DeviceNotRegistered') {
          await deactivateDeviceByToken(tx, ref.device.expoPushToken);
          logger.info(
            { outboxId: ref.row.id, token: ref.device.expoPushToken },
            'push-worker: устройство деактивировано (DeviceNotRegistered, ticket)',
          );
        } else {
          logger.warn(
            { outboxId: ref.row.id, token: ref.device.expoPushToken, error: ticket.message },
            'push-worker: тикет Expo с ошибкой',
          );
        }
      }
    }

    let sent = 0;
    let failed = 0;

    for (const row of rows) {
      const activeDevices = deviceLists.get(row.id) ?? [];

      if (activeDevices.length === 0) {
        await markOutboxAttemptFailed(tx, row, 'No active devices for user', options.maxAttempts);
        failed += 1;
        logger.debug({ outboxId: row.id, userId: row.userId }, 'push-worker: нет активных устройств');
        continue;
      }

      if (sendError !== null) {
        const message = sendError instanceof Error ? sendError.message : 'Expo request failed';
        await markOutboxAttemptFailed(tx, row, message, options.maxAttempts);
        failed += 1;
        continue;
      }

      const successTickets = successByRowId.get(row.id) ?? [];

      if (successTickets.length > 0) {
        await markOutboxSent(tx, row.id, successTickets);
        sent += 1;
      } else {
        await markOutboxAttemptFailed(tx, row, 'All devices rejected by Expo', options.maxAttempts);
        failed += 1;
      }
    }

    logger.info({ sent, failed }, 'push-worker: стадия отправки завершена');

    return { sent, failed };
  });

/** Запрашивает receipt'ы чанками по лимиту Expo и сливает результат в одну карту id → receipt. */
const fetchAllReceipts = async (
  expoClient: IExpoClient,
  receiptIds: string[],
): Promise<Record<string, ExpoPushReceipt>> => {
  const chunks = chunkArray(receiptIds, Expo.pushNotificationReceiptChunkSizeLimit);
  const merged: Record<string, ExpoPushReceipt> = {};

  for (const chunk of chunks) {
    const chunkReceipts = await expoClient.getPushNotificationReceiptsAsync(chunk);
    Object.assign(merged, chunkReceipts);
  }

  return merged;
};

/**
 * Стадия receipt'ов push-worker'а (T-16, решение #2 фазы 6): sent-записи старше
 * PUSH_RECEIPT_DELAY_MIN → getPushNotificationReceiptsAsync. Receipt ещё не готов у Expo (id
 * отсутствует в ответе) → строка остаётся sent до следующего прогона. Все receipt'ы строки готовы:
 * все 'ok' → запись удаляется (успех), любая ошибка → failed + деактивация по DeviceNotRegistered.
 */
export const runPushReceiptStage = async (
  db: NodePgDatabase,
  expoClient: IExpoClient,
  options: IPushReceiptStageOptions,
  logger: FastifyBaseLogger,
): Promise<IPushReceiptResult> =>
  db.transaction(async (tx) => {
    const olderThan = new Date(Date.now() - options.receiptDelayMin * 60_000);
    const rows = await listSentOutboxOlderThan(tx, olderThan, options.batchLimit);

    if (rows.length === 0) {
      return { finalized: 0, failed: 0, pending: 0 };
    }

    logger.debug({ count: rows.length }, 'push-worker: receipt-стадия — забраны кандидаты');

    const allTicketIds = new Set<string>();

    for (const row of rows) {
      for (const ticket of row.tickets ?? []) {
        allTicketIds.add(ticket.ticketId);
      }
    }

    let receiptsById: Record<string, ExpoPushReceipt> = {};

    if (allTicketIds.size > 0) {
      try {
        receiptsById = await fetchAllReceipts(expoClient, [...allTicketIds]);
      } catch (error) {
        logger.warn({ err: error }, 'push-worker: запрос receipt к Expo завершился ошибкой');

        return { finalized: 0, failed: 0, pending: rows.length };
      }
    }

    let finalized = 0;
    let failed = 0;
    let pending = 0;

    for (const row of rows) {
      const rowTickets = row.tickets ?? [];
      const withReceipts = rowTickets.map((ticket) => ({
        ticket,
        receipt: receiptsById[ticket.ticketId],
      }));

      if (withReceipts.some(({ receipt }) => receipt === undefined)) {
        pending += 1;
        continue;
      }

      let hasError = false;
      let firstErrorMessage: string | null = null;

      for (const { ticket, receipt } of withReceipts) {
        if (receipt === undefined || receipt.status !== 'error') {
          continue;
        }

        hasError = true;
        firstErrorMessage ??= receipt.message;

        if (receipt.details?.error === 'DeviceNotRegistered') {
          await deactivateDeviceByToken(tx, ticket.token);
          logger.info(
            { outboxId: row.id, token: ticket.token },
            'push-worker: устройство деактивировано (DeviceNotRegistered, receipt)',
          );
        }
      }

      if (hasError) {
        await markOutboxReceiptFailed(tx, row.id, firstErrorMessage ?? 'Expo receipt error');
        failed += 1;
      } else {
        await deleteOutboxById(tx, row.id);
        finalized += 1;
      }
    }

    logger.info({ finalized, failed, pending }, 'push-worker: receipt-стадия завершена');

    return { finalized, failed, pending };
  });
