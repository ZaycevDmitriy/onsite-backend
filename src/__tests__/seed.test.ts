import { inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { orderAssignments, orders } from '@/modules/orders/db-schema.js';
import { users } from '@/modules/users/db-schema.js';
import { createPool } from '@/shared/db/index.js';

import { runSeed, SEED_ORDER_IDS, SEED_USER_IDS, SEED_USERS } from '../../scripts/seed-data.js';

import type pg from 'pg';

// Интеграционный тест идемпотентности сида (FR-16): требует реальной БД с миграциями.
const databaseUrl = process.env.DATABASE_URL;

describe.runIf(databaseUrl)('runSeed', () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = createPool(databaseUrl as string);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('двойной запуск не создаёт дубликатов', async () => {
    const db = drizzle(pool);
    const logger = pino({ level: 'silent' });

    await runSeed(db, logger);
    await runSeed(db, logger);

    // Выборка по фиксированным UUID сида: тест не зависит от прочих данных в БД.
    const seededUsers = await db
      .select()
      .from(users)
      .where(inArray(users.id, Object.values(SEED_USER_IDS)));
    const seededOrders = await db
      .select()
      .from(orders)
      .where(inArray(orders.id, [...SEED_ORDER_IDS]));
    const assignments = await db
      .select()
      .from(orderAssignments)
      .where(inArray(orderAssignments.orderId, [...SEED_ORDER_IDS]));

    expect(seededUsers).toHaveLength(3);
    expect(seededOrders).toHaveLength(6);
    expect(assignments).toHaveLength(4);

    // Совместимость с mock.ts: первая заявка — «Установка роутера» на Тверской.
    const first = seededOrders.find((order) => order.title === 'Установка роутера');
    expect(first).toMatchObject({
      address: 'ул. Тверская, 15',
      latitude: 55.76233,
      longitude: 37.60797,
      status: 'New',
    });

    // Роли из сида: 1 диспетчер + 2 техника.
    expect(seededUsers.filter((user) => user.role === 'dispatcher')).toHaveLength(1);
    expect(seededUsers.filter((user) => user.role === 'technician')).toHaveLength(2);
    expect(SEED_USERS.map((user) => user.email)).toContain('dispatcher@onsite.local');
  });
});
