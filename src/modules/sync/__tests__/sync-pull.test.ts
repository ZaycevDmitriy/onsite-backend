import { randomUUID } from 'node:crypto';

import { hash } from '@node-rs/argon2';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeTestConfig } from '@/__tests__/helpers/test-config.js';
import { buildApp } from '@/app.js';
import { refreshSessions } from '@/modules/auth/db-schema.js';
import { orderAssignments, orderEvents, orders } from '@/modules/orders/db-schema.js';
import { users } from '@/modules/users/db-schema.js';

import type { UserRoleEnum } from '@/modules/users/index.js';
import type { FastifyInstance } from 'fastify';

// Интеграционные тесты pull-синхронизации (FR-08, T-10): требуют реальной БД.
const databaseUrl = process.env.DATABASE_URL;

const PASSWORD = 'sync-pull-test-secret-1';
const EMAIL_PREFIX = 'sync-pull-test-';
const PAGINATION_TOTAL = 500;
const PAGINATION_LIMIT = 200;

interface ISyncOrderItem {
  type: 'order';
  seq: number;
  order: { id: string; status: string; updatedSeq: number; photos: unknown[] };
}

interface ISyncUnassignedItem {
  type: 'unassigned';
  seq: number;
  orderId: string;
}

type ISyncItem = ISyncOrderItem | ISyncUnassignedItem;

interface ISyncPullResponse {
  items: ISyncItem[];
  nextCursor: number;
}

describe.runIf(databaseUrl)('sync pull (FR-08)', () => {
  let app: FastifyInstance;
  let dispatcherToken: string;
  const createdUserIds: string[] = [];
  const createdOrderIds: string[] = [];

  const seedUser = async (role: UserRoleEnum): Promise<{ id: string; email: string }> => {
    const id = randomUUID();
    const email = `${EMAIL_PREFIX}${id}@onsite.test`;
    await app.db.insert(users).values({
      id,
      email,
      passwordHash: await hash(PASSWORD),
      role,
      displayName: 'Тестовый Участник',
    });
    createdUserIds.push(id);

    return { id, email };
  };

  const loginAs = async (email: string): Promise<string> => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password: PASSWORD },
    });
    expect(response.statusCode).toBe(200);

    return response.json<{ accessToken: string }>().accessToken;
  };

  const authHeaders = (token: string): Record<string, string> => ({
    authorization: `Bearer ${token}`,
  });

  const buildOrderPayload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => {
    const now = Date.now();

    return {
      title: 'Тестовая заявка синка',
      client: 'Тестовый Клиент',
      address: 'ул. Тестовая, 1',
      description: 'Описание тестовой заявки для sync pull.',
      scheduledAt: new Date(now).toISOString(),
      slotStart: new Date(now).toISOString(),
      slotEnd: new Date(now + 60 * 60 * 1000).toISOString(),
      ...overrides,
    };
  };

  const createOrder = async (overrides: Record<string, unknown> = {}): Promise<{ id: string }> => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: authHeaders(dispatcherToken),
      payload: buildOrderPayload(overrides),
    });
    expect(response.statusCode).toBe(201);
    const body = response.json<{ id: string }>();
    createdOrderIds.push(body.id);

    return body;
  };

  const assignTechnician = async (orderId: string, technicianId: string): Promise<void> => {
    const response = await app.inject({
      method: 'POST',
      url: `/v1/orders/${orderId}/assign`,
      headers: authHeaders(dispatcherToken),
      payload: { technicianId },
    });
    expect(response.statusCode).toBe(200);
  };

  const pull = async (token: string, query = ''): Promise<ISyncPullResponse> => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/sync/orders${query}`,
      headers: authHeaders(token),
    });
    expect(response.statusCode).toBe(200);

    return response.json<ISyncPullResponse>();
  };

  beforeAll(async () => {
    // safetyLag=0: курсор в тестах детерминированно двигается до текущего максимума без хвоста.
    app = await buildApp(makeTestConfig(databaseUrl as string, { syncSafetyLag: 0 }));
    await app.ready();

    const dispatcher = await seedUser('dispatcher');
    dispatcherToken = await loginAs(dispatcher.email);
  });

  afterAll(async () => {
    if (createdOrderIds.length > 0) {
      await app.db.delete(orderEvents).where(inArray(orderEvents.orderId, createdOrderIds));
      await app.db
        .delete(orderAssignments)
        .where(inArray(orderAssignments.orderId, createdOrderIds));
      await app.db.delete(orders).where(inArray(orders.id, createdOrderIds));
    }
    if (createdUserIds.length > 0) {
      await app.db.delete(refreshSessions).where(inArray(refreshSessions.userId, createdUserIds));
      await app.db.delete(users).where(inArray(users.id, createdUserIds));
    }
    await app.close();
  });

  it('пустой повторный pull: без изменений — items=[], курсор не двигается', async () => {
    const technician = await seedUser('technician');
    const technicianToken = await loginAs(technician.email);

    const first = await pull(technicianToken);
    expect(first.items).toEqual([]);

    const second = await pull(technicianToken, `?cursor=${first.nextCursor}`);
    expect(second.items).toEqual([]);
    expect(second.nextCursor).toBe(first.nextCursor);
  });

  it('изменение заявки видно ровно один раз', async () => {
    const technician = await seedUser('technician');
    const technicianToken = await loginAs(technician.email);

    const before = await pull(technicianToken);

    const order = await createOrder();
    await assignTechnician(order.id, technician.id);

    const after = await pull(technicianToken, `?cursor=${before.nextCursor}`);
    const orderItems = after.items.filter(
      (item): item is ISyncOrderItem => item.type === 'order' && item.order.id === order.id,
    );
    expect(orderItems).toHaveLength(1);

    const again = await pull(technicianToken, `?cursor=${after.nextCursor}`);
    expect(again.items.some((item) => item.type === 'order' && item.order.id === order.id)).toBe(
      false,
    );
  });

  it('пагинация: 500 заявок с limit=200 отдаются за 3 запроса без потерь и дублей', async () => {
    const technician = await seedUser('technician');
    const technicianToken = await loginAs(technician.email);

    const before = await pull(technicianToken);

    const now = new Date();
    const rows = Array.from({ length: PAGINATION_TOTAL }, (_, index) => ({
      title: `Заявка пагинации ${index}`,
      client: 'Тестовый Клиент',
      address: 'ул. Тестовая, 1',
      description: 'Описание заявки для теста пагинации sync pull.',
      scheduledAt: now,
      slotStart: now,
      slotEnd: new Date(now.getTime() + 60 * 60 * 1000),
      assignedTo: technician.id,
    }));
    const inserted = await app.db.insert(orders).values(rows).returning({ id: orders.id });
    createdOrderIds.push(...inserted.map((row) => row.id));

    let cursor = before.nextCursor;
    const seenIds = new Set<string>();
    let requests = 0;

    for (let i = 0; i < 10; i += 1) {
      const page = await pull(technicianToken, `?cursor=${cursor}&limit=${PAGINATION_LIMIT}`);
      requests += 1;
      for (const item of page.items) {
        if (item.type === 'order') {
          seenIds.add(item.order.id);
        }
      }
      cursor = page.nextCursor;

      if (page.items.length < PAGINATION_LIMIT) {
        break;
      }
    }

    expect(requests).toBe(3);
    expect(seenIds.size).toBe(PAGINATION_TOTAL);
    for (const row of inserted) {
      expect(seenIds.has(row.id)).toBe(true);
    }
  });

  it('переназначение техника → tombstone на pull прежнего техника', async () => {
    const technician1 = await seedUser('technician');
    const technician2 = await seedUser('technician');
    const technician1Token = await loginAs(technician1.email);

    const before = await pull(technician1Token);

    const order = await createOrder();
    await assignTechnician(order.id, technician1.id);
    await assignTechnician(order.id, technician2.id);

    const after = await pull(technician1Token, `?cursor=${before.nextCursor}`);
    const tombstones = after.items.filter(
      (item): item is ISyncUnassignedItem => item.type === 'unassigned' && item.orderId === order.id,
    );
    expect(tombstones).toHaveLength(1);
    expect(after.items.some((item) => item.type === 'order' && item.order.id === order.id)).toBe(
      false,
    );
  });
});
