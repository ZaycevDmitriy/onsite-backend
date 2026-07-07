import { randomUUID } from 'node:crypto';

import { hash } from '@node-rs/argon2';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { makeTestConfig } from '@/__tests__/helpers/test-config.js';
import { buildApp } from '@/app.js';
import { refreshSessions } from '@/modules/auth/db-schema.js';
import { devices, PushOutboxStatusEnum, pushOutbox } from '@/modules/notifications/db-schema.js';
import { runPushReceiptStage, runPushSendStage } from '@/modules/notifications/index.js';
import { users } from '@/modules/users/db-schema.js';

import type { IExpoClient } from '@/modules/notifications/index.js';
import type { UserRoleEnum } from '@/modules/users/index.js';
import type { ExpoPushMessage, ExpoPushReceipt, ExpoPushTicket } from 'expo-server-sdk';
import type { FastifyInstance } from 'fastify';

// Интеграционные тесты push-worker'а (T-16): требуют реальной БД, Expo подменяется фейком.
const databaseUrl = process.env.DATABASE_URL;

const PASSWORD = 'worker-test-secret-1';
const EMAIL_PREFIX = 'worker-test-';

const makeExpoPushToken = (): string => `ExponentPushToken[${randomUUID().replace(/-/g, '')}]`;

// Фейковый Expo-клиент: поведение задаётся тестом, реальная сеть не используется.
const makeFakeExpoClient = (overrides: {
  send?: (messages: ExpoPushMessage[]) => Promise<ExpoPushTicket[]>;
  receipts?: (receiptIds: string[]) => Promise<Record<string, ExpoPushReceipt>>;
}): IExpoClient => ({
  sendPushNotificationsAsync:
    overrides.send ??
    ((messages) => Promise.resolve(messages.map(() => ({ status: 'ok', id: randomUUID() })))),
  getPushNotificationReceiptsAsync: overrides.receipts ?? (() => Promise.resolve({})),
});

describe.runIf(databaseUrl)('push-worker (T-16)', () => {
  let app: FastifyInstance;
  const createdUserIds: string[] = [];

  const seedTechnicianWithDevices = async (
    tokens: string[],
  ): Promise<{ userId: string; tokens: string[] }> => {
    const id = randomUUID();
    const email = `${EMAIL_PREFIX}${id}@onsite.test`;
    await app.db.insert(users).values({
      id,
      email,
      passwordHash: await hash(PASSWORD),
      role: 'technician' as UserRoleEnum,
      displayName: 'Воркер Техник',
    });
    createdUserIds.push(id);

    for (const token of tokens) {
      await app.db.insert(devices).values({ userId: id, expoPushToken: token });
    }

    return { userId: id, tokens };
  };

  const enqueue = async (userId: string, message: unknown = { title: 't', body: 'b' }) => {
    const rows = await app.db.insert(pushOutbox).values({ userId, message }).returning();

    // returning() по одной записи всегда отдаёт ровно одну строку.
    return rows[0] as typeof pushOutbox.$inferSelect;
  };

  const findOutboxById = async (id: number) => {
    const rows = await app.db.select().from(pushOutbox).where(eq(pushOutbox.id, id));

    return rows[0] ?? null;
  };

  const findDeviceByToken = async (token: string) => {
    const rows = await app.db.select().from(devices).where(eq(devices.expoPushToken, token));

    return rows[0] ?? null;
  };

  beforeAll(async () => {
    app = await buildApp(makeTestConfig(databaseUrl as string));
    await app.ready();
  });

  afterEach(async () => {
    // Каждый тест сам заводит своего техника и свою outbox-запись: изоляция от соседних
    // тестов обязательна — воркер обрабатывает записи глобально, без фильтра по пользователю.
    if (createdUserIds.length > 0) {
      await app.db.delete(pushOutbox).where(inArray(pushOutbox.userId, createdUserIds));
    }
  });

  afterAll(async () => {
    await app.db.delete(pushOutbox).where(inArray(pushOutbox.userId, createdUserIds));
    await app.db.delete(devices).where(inArray(devices.userId, createdUserIds));
    await app.db.delete(refreshSessions).where(inArray(refreshSessions.userId, createdUserIds));
    await app.db.delete(users).where(inArray(users.id, createdUserIds));
    await app.close();
  });

  describe('стадия отправки', () => {
    it('оба устройства техника получают push (FR-13)', async () => {
      const [tokenA, tokenB] = [makeExpoPushToken(), makeExpoPushToken()];
      const technician = await seedTechnicianWithDevices([tokenA, tokenB]);
      const outbox = await enqueue(technician.userId);

      const expoClient = makeFakeExpoClient({});
      const result = await runPushSendStage(
        app.db,
        expoClient,
        { batchLimit: 50, maxAttempts: 5 },
        app.log,
      );

      // Агрегат result не сравнивается строго: другие тестовые файлы параллельно создают
      // свои pending-записи outbox (assignOrder без зарегистрированных устройств), их
      // stage-прогон в этом же батче — не предмет теста. Предмет — состояние своей записи.
      expect(result.sent).toBeGreaterThanOrEqual(1);

      const row = await findOutboxById(outbox.id);
      expect(row?.status).toBe(PushOutboxStatusEnum.Sent);
      expect(row?.tickets).toHaveLength(2);
      expect(row?.tickets?.map((t) => t.token).sort()).toEqual([tokenA, tokenB].sort());
    });

    it('DeviceNotRegistered деактивирует токен, второе устройство всё равно получает push', async () => {
      const [deadToken, aliveToken] = [makeExpoPushToken(), makeExpoPushToken()];
      const technician = await seedTechnicianWithDevices([deadToken, aliveToken]);
      const outbox = await enqueue(technician.userId);

      const expoClient = makeFakeExpoClient({
        send: (messages) =>
          Promise.resolve(
            messages.map((message): ExpoPushTicket =>
              message.to === deadToken
                ? {
                    status: 'error',
                    message: 'not registered',
                    details: { error: 'DeviceNotRegistered' },
                  }
                : { status: 'ok', id: randomUUID() },
            ),
          ),
      });

      const result = await runPushSendStage(
        app.db,
        expoClient,
        { batchLimit: 50, maxAttempts: 5 },
        app.log,
      );

      expect(result.sent).toBeGreaterThanOrEqual(1);

      const row = await findOutboxById(outbox.id);
      expect(row?.status).toBe(PushOutboxStatusEnum.Sent);
      expect(row?.tickets).toHaveLength(1);
      expect(row?.tickets?.[0]?.token).toBe(aliveToken);

      const deadDevice = await findDeviceByToken(deadToken);
      expect(deadDevice?.isActive).toBe(false);
      const aliveDevice = await findDeviceByToken(aliveToken);
      expect(aliveDevice?.isActive).toBe(true);
    });

    it('ошибка отправки инкрементит attempts, после лимита — failed (ретраи)', async () => {
      const technician = await seedTechnicianWithDevices([makeExpoPushToken()]);
      const outbox = await enqueue(technician.userId);

      const failingClient = makeFakeExpoClient({
        send: () => Promise.reject(new Error('Expo недоступен')),
      });

      const first = await runPushSendStage(
        app.db,
        failingClient,
        { batchLimit: 50, maxAttempts: 2 },
        app.log,
      );
      expect(first.sent).toBe(0);
      expect(first.failed).toBeGreaterThanOrEqual(1);

      const afterFirst = await findOutboxById(outbox.id);
      expect(afterFirst?.status).toBe(PushOutboxStatusEnum.Pending);
      expect(afterFirst?.attempts).toBe(1);

      const second = await runPushSendStage(
        app.db,
        failingClient,
        { batchLimit: 50, maxAttempts: 2 },
        app.log,
      );
      expect(second.sent).toBe(0);
      expect(second.failed).toBeGreaterThanOrEqual(1);

      const afterSecond = await findOutboxById(outbox.id);
      expect(afterSecond?.status).toBe(PushOutboxStatusEnum.Failed);
      expect(afterSecond?.attempts).toBe(2);
      expect(afterSecond?.lastError).toContain('Expo недоступен');
    });

    it('нет активных устройств — сразу attempt-failed', async () => {
      const technician = await seedTechnicianWithDevices([]);
      const outbox = await enqueue(technician.userId);

      const expoClient = makeFakeExpoClient({});
      const result = await runPushSendStage(
        app.db,
        expoClient,
        { batchLimit: 50, maxAttempts: 5 },
        app.log,
      );

      expect(result.failed).toBeGreaterThanOrEqual(1);

      const row = await findOutboxById(outbox.id);
      expect(row?.status).toBe(PushOutboxStatusEnum.Pending);
      expect(row?.lastError).toContain('No active devices');
    });
  });

  describe('стадия receipt', () => {
    const backdateSentRow = async (
      outboxId: number,
      tickets: { token: string; ticketId: string }[],
      minutesAgo: number,
    ): Promise<void> => {
      await app.db
        .update(pushOutbox)
        .set({
          status: PushOutboxStatusEnum.Sent,
          tickets,
          sentAt: new Date(Date.now() - minutesAgo * 60_000),
        })
        .where(eq(pushOutbox.id, outboxId));
    };

    it('все receipts ok — запись удаляется (успех)', async () => {
      const technician = await seedTechnicianWithDevices([makeExpoPushToken()]);
      const outbox = await enqueue(technician.userId);
      const ticketId = randomUUID();
      await backdateSentRow(outbox.id, [{ token: technician.tokens[0] as string, ticketId }], 20);

      const expoClient = makeFakeExpoClient({
        receipts: () => Promise.resolve({ [ticketId]: { status: 'ok' } }),
      });

      const result = await runPushReceiptStage(
        app.db,
        expoClient,
        { batchLimit: 50, receiptDelayMin: 15 },
        app.log,
      );

      expect(result).toEqual({ finalized: 1, failed: 0, pending: 0 });
      expect(await findOutboxById(outbox.id)).toBeNull();
    });

    it('receipt DeviceNotRegistered — устройство деактивируется, запись failed', async () => {
      const token = makeExpoPushToken();
      const technician = await seedTechnicianWithDevices([token]);
      const outbox = await enqueue(technician.userId);
      const ticketId = randomUUID();
      await backdateSentRow(outbox.id, [{ token, ticketId }], 20);

      const expoClient = makeFakeExpoClient({
        receipts: () =>
          Promise.resolve({
            [ticketId]: {
              status: 'error',
              message: 'not registered',
              details: { error: 'DeviceNotRegistered' },
            },
          }),
      });

      const result = await runPushReceiptStage(
        app.db,
        expoClient,
        { batchLimit: 50, receiptDelayMin: 15 },
        app.log,
      );

      expect(result).toEqual({ finalized: 0, failed: 1, pending: 0 });

      const row = await findOutboxById(outbox.id);
      expect(row?.status).toBe(PushOutboxStatusEnum.Failed);

      const device = await findDeviceByToken(token);
      expect(device?.isActive).toBe(false);
    });

    it('receipt ещё не готов у Expo — запись остаётся sent', async () => {
      const token = makeExpoPushToken();
      const technician = await seedTechnicianWithDevices([token]);
      const outbox = await enqueue(technician.userId);
      const ticketId = randomUUID();
      await backdateSentRow(outbox.id, [{ token, ticketId }], 20);

      const expoClient = makeFakeExpoClient({ receipts: () => Promise.resolve({}) });

      const result = await runPushReceiptStage(
        app.db,
        expoClient,
        { batchLimit: 50, receiptDelayMin: 15 },
        app.log,
      );

      expect(result).toEqual({ finalized: 0, failed: 0, pending: 1 });

      const row = await findOutboxById(outbox.id);
      expect(row?.status).toBe(PushOutboxStatusEnum.Sent);
    });

    it('тикет моложе PUSH_RECEIPT_DELAY_MIN — не забирается стадией', async () => {
      const token = makeExpoPushToken();
      const technician = await seedTechnicianWithDevices([token]);
      const outbox = await enqueue(technician.userId);
      const ticketId = randomUUID();
      await backdateSentRow(outbox.id, [{ token, ticketId }], 1);

      const expoClient = makeFakeExpoClient({
        receipts: () => Promise.resolve({ [ticketId]: { status: 'ok' } }),
      });

      const result = await runPushReceiptStage(
        app.db,
        expoClient,
        { batchLimit: 50, receiptDelayMin: 15 },
        app.log,
      );

      expect(result).toEqual({ finalized: 0, failed: 0, pending: 0 });

      const row = await findOutboxById(outbox.id);
      expect(row?.status).toBe(PushOutboxStatusEnum.Sent);
    });
  });
});
