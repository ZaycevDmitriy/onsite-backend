import { eq } from 'drizzle-orm';

import { devices } from './db-schema.js';

import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

// Строка таблицы devices как её видит Drizzle.
export type IDeviceRow = typeof devices.$inferSelect;

// Транзакционный или обычный клиент Drizzle — регистрация устройства не завязана на транзакцию.
export type DbClient = NodePgDatabase | Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0];

export interface IInsertDeviceInput {
  userId: string;
  expoPushToken: string;
}

/** Ищет устройство по expo-push-токену (токен уникален глобально). */
export const findDeviceByToken = async (
  db: DbClient,
  expoPushToken: string,
): Promise<IDeviceRow | null> => {
  const rows = await db.select().from(devices).where(eq(devices.expoPushToken, expoPushToken)).limit(1);

  return rows[0] ?? null;
};

/** Вставляет новое устройство. */
export const insertDevice = async (db: DbClient, input: IInsertDeviceInput): Promise<IDeviceRow> => {
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
