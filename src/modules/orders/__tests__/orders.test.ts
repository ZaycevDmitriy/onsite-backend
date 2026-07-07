import { randomUUID } from 'node:crypto';

import { hash } from '@node-rs/argon2';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeTestConfig } from '@/__tests__/helpers/test-config.js';
import { buildApp } from '@/app.js';
import { orderAssignments, orderEvents, orders } from '@/modules/orders/db-schema.js';
import { refreshSessions } from '@/modules/auth/db-schema.js';
import { users } from '@/modules/users/db-schema.js';

import type { UserRoleEnum } from '@/modules/users/index.js';
import type { FastifyInstance } from 'fastify';

// Интеграционные тесты модуля заявок (FR-03, FR-05, FR-06, FR-07, FR-15): требуют реальной БД.
const databaseUrl = process.env.DATABASE_URL;

const PASSWORD = 'orders-test-secret-1';
const EMAIL_PREFIX = 'orders-test-';

interface IOrderView {
  id: string;
  status: string;
  assignedTo: string | null;
  updatedSeq: number;
}

describe.runIf(databaseUrl)('модуль заявок', () => {
  let app: FastifyInstance;
  let dispatcherId: string;
  let dispatcherToken: string;
  const createdUserIds: string[] = [];
  const createdOrderIds: string[] = [];

  const seedUser = async (
    role: UserRoleEnum,
    isActive = true,
  ): Promise<{ id: string; email: string }> => {
    const id = randomUUID();
    const email = `${EMAIL_PREFIX}${id}@onsite.test`;
    await app.db.insert(users).values({
      id,
      email,
      passwordHash: await hash(PASSWORD),
      role,
      displayName: 'Тестовый Участник',
      isActive,
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
      title: 'Тестовая заявка',
      client: 'Тестовый Клиент',
      address: 'ул. Тестовая, 1',
      description: 'Описание тестовой заявки для интеграционного теста.',
      scheduledAt: new Date(now).toISOString(),
      slotStart: new Date(now).toISOString(),
      slotEnd: new Date(now + 60 * 60 * 1000).toISOString(),
      latitude: 55.7558,
      longitude: 37.6173,
      ...overrides,
    };
  };

  const createOrder = async (overrides: Record<string, unknown> = {}): Promise<IOrderView> => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: authHeaders(dispatcherToken),
      payload: buildOrderPayload(overrides),
    });
    expect(response.statusCode).toBe(201);
    const body = response.json<IOrderView>();
    createdOrderIds.push(body.id);

    return body;
  };

  beforeAll(async () => {
    app = await buildApp(makeTestConfig(databaseUrl as string));
    await app.ready();

    const dispatcher = await seedUser('dispatcher');
    dispatcherId = dispatcher.id;
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

  describe('CRUD заявок (FR-05)', () => {
    it('dispatcher создаёт заявку → 201', async () => {
      const order = await createOrder({ title: 'Установка оборудования' });

      expect(order.status).toBe('New');
      expect(order.assignedTo).toBeNull();
      expect(order.updatedSeq).toEqual(expect.any(Number));
    });

    it('пустой title → 422 validation_failed', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/orders',
        headers: authHeaders(dispatcherToken),
        payload: buildOrderPayload({ title: '' }),
      });

      expect(response.statusCode).toBe(422);
      expect(response.json<{ code: string }>().code).toBe('validation_failed');
    });

    it('невалидные координаты → 422 validation_failed', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/orders',
        headers: authHeaders(dispatcherToken),
        payload: buildOrderPayload({ latitude: 200 }),
      });

      expect(response.statusCode).toBe(422);
      expect(response.json<{ code: string }>().code).toBe('validation_failed');
    });

    it('technician создаёт заявку → 403 (FR-03)', async () => {
      const technician = await seedUser('technician');
      const technicianToken = await loginAs(technician.email);

      const response = await app.inject({
        method: 'POST',
        url: '/v1/orders',
        headers: authHeaders(technicianToken),
        payload: buildOrderPayload(),
      });

      expect(response.statusCode).toBe(403);
    });

    it('PATCH правит поля и растит updated_seq', async () => {
      const order = await createOrder();

      const response = await app.inject({
        method: 'PATCH',
        url: `/v1/orders/${order.id}`,
        headers: authHeaders(dispatcherToken),
        payload: { title: 'Обновлённый заголовок' },
      });

      expect(response.statusCode).toBe(200);
      const updated = response.json<IOrderView & { title: string }>();
      expect(updated.title).toBe('Обновлённый заголовок');
      expect(updated.updatedSeq).toBeGreaterThan(order.updatedSeq);
    });

    it('PATCH на завершённую заявку → 409', async () => {
      const order = await createOrder();

      const toInProgress = await app.inject({
        method: 'POST',
        url: `/v1/orders/${order.id}/transition`,
        headers: authHeaders(dispatcherToken),
        payload: { to: 'InProgress', baseStatus: 'New' },
      });
      expect(toInProgress.statusCode).toBe(200);

      const toDone = await app.inject({
        method: 'POST',
        url: `/v1/orders/${order.id}/transition`,
        headers: authHeaders(dispatcherToken),
        payload: { to: 'Done', baseStatus: 'InProgress' },
      });
      expect(toDone.statusCode).toBe(200);

      const patch = await app.inject({
        method: 'PATCH',
        url: `/v1/orders/${order.id}`,
        headers: authHeaders(dispatcherToken),
        payload: { title: 'Не должно примениться' },
      });

      expect(patch.statusCode).toBe(409);
    });
  });

  describe('назначение заявки (FR-06)', () => {
    it('назначает техника → 200, событие и активная запись истории', async () => {
      const order = await createOrder();
      const technician = await seedUser('technician');

      const response = await app.inject({
        method: 'POST',
        url: `/v1/orders/${order.id}/assign`,
        headers: authHeaders(dispatcherToken),
        payload: { technicianId: technician.id },
      });

      expect(response.statusCode).toBe(200);
      const assigned = response.json<IOrderView>();
      expect(assigned.assignedTo).toBe(technician.id);
      expect(assigned.updatedSeq).toBeGreaterThan(order.updatedSeq);

      const activeRows = await app.db
        .select()
        .from(orderAssignments)
        .where(inArray(orderAssignments.orderId, [order.id]));
      expect(activeRows).toHaveLength(1);
      expect(activeRows[0]?.userId).toBe(technician.id);
      expect(activeRows[0]?.unassignedAt).toBeNull();
    });

    it('повторное назначение того же техника — идемпотентно, без дублей истории', async () => {
      const order = await createOrder();
      const technician = await seedUser('technician');

      const first = await app.inject({
        method: 'POST',
        url: `/v1/orders/${order.id}/assign`,
        headers: authHeaders(dispatcherToken),
        payload: { technicianId: technician.id },
      });
      const firstBody = first.json<IOrderView>();

      const second = await app.inject({
        method: 'POST',
        url: `/v1/orders/${order.id}/assign`,
        headers: authHeaders(dispatcherToken),
        payload: { technicianId: technician.id },
      });

      expect(second.statusCode).toBe(200);
      const secondBody = second.json<IOrderView>();
      expect(secondBody.updatedSeq).toBe(firstBody.updatedSeq);

      const rows = await app.db
        .select()
        .from(orderAssignments)
        .where(inArray(orderAssignments.orderId, [order.id]));
      expect(rows).toHaveLength(1);
    });

    it('переназначение другому технику закрывает прежнюю запись tombstone (unassigned_seq)', async () => {
      const order = await createOrder();
      const technician1 = await seedUser('technician');
      const technician2 = await seedUser('technician');

      await app.inject({
        method: 'POST',
        url: `/v1/orders/${order.id}/assign`,
        headers: authHeaders(dispatcherToken),
        payload: { technicianId: technician1.id },
      });

      const reassign = await app.inject({
        method: 'POST',
        url: `/v1/orders/${order.id}/assign`,
        headers: authHeaders(dispatcherToken),
        payload: { technicianId: technician2.id },
      });
      expect(reassign.statusCode).toBe(200);
      expect(reassign.json<IOrderView>().assignedTo).toBe(technician2.id);

      const rows = await app.db
        .select()
        .from(orderAssignments)
        .where(inArray(orderAssignments.orderId, [order.id]));
      expect(rows).toHaveLength(2);

      const oldRow = rows.find((row) => row.userId === technician1.id);
      const newRow = rows.find((row) => row.userId === technician2.id);
      expect(oldRow?.unassignedAt).not.toBeNull();
      expect(oldRow?.unassignedSeq).not.toBeNull();
      expect(newRow?.unassignedAt).toBeNull();
    });

    it('назначение на несуществующего техника → 422', async () => {
      const order = await createOrder();

      const response = await app.inject({
        method: 'POST',
        url: `/v1/orders/${order.id}/assign`,
        headers: authHeaders(dispatcherToken),
        payload: { technicianId: randomUUID() },
      });

      expect(response.statusCode).toBe(422);
    });

    it('назначение на деактивированного техника → 422', async () => {
      const order = await createOrder();
      const technician = await seedUser('technician', false);

      const response = await app.inject({
        method: 'POST',
        url: `/v1/orders/${order.id}/assign`,
        headers: authHeaders(dispatcherToken),
        payload: { technicianId: technician.id },
      });

      expect(response.statusCode).toBe(422);
    });

    it('назначение на dispatcher (не technician) → 422', async () => {
      const order = await createOrder();

      const response = await app.inject({
        method: 'POST',
        url: `/v1/orders/${order.id}/assign`,
        headers: authHeaders(dispatcherToken),
        payload: { technicianId: dispatcherId },
      });

      expect(response.statusCode).toBe(422);
    });

    it('назначение заявки в статусе Done → 409', async () => {
      const order = await createOrder();
      const technician = await seedUser('technician');

      await app.inject({
        method: 'POST',
        url: `/v1/orders/${order.id}/transition`,
        headers: authHeaders(dispatcherToken),
        payload: { to: 'InProgress', baseStatus: 'New' },
      });
      await app.inject({
        method: 'POST',
        url: `/v1/orders/${order.id}/transition`,
        headers: authHeaders(dispatcherToken),
        payload: { to: 'Done', baseStatus: 'InProgress' },
      });

      const response = await app.inject({
        method: 'POST',
        url: `/v1/orders/${order.id}/assign`,
        headers: authHeaders(dispatcherToken),
        payload: { technicianId: technician.id },
      });

      expect(response.statusCode).toBe(409);
    });
  });

  describe('конечный автомат статусов (FR-07)', () => {
    it('допустимый переход New → InProgress растит updated_seq', async () => {
      const order = await createOrder();

      const response = await app.inject({
        method: 'POST',
        url: `/v1/orders/${order.id}/transition`,
        headers: authHeaders(dispatcherToken),
        payload: { to: 'InProgress', baseStatus: 'New' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json<IOrderView>();
      expect(body.status).toBe('InProgress');
      expect(body.updatedSeq).toBeGreaterThan(order.updatedSeq);
    });

    it('недопустимый переход New → Done → 409 invalid_transition с текущим статусом', async () => {
      const order = await createOrder();

      const response = await app.inject({
        method: 'POST',
        url: `/v1/orders/${order.id}/transition`,
        headers: authHeaders(dispatcherToken),
        payload: { to: 'Done', baseStatus: 'New' },
      });

      expect(response.statusCode).toBe(409);
      const body = response.json<{ code: string; details?: { status?: string } }>();
      expect(body.code).toBe('invalid_transition');
      expect(body.details?.status).toBe('New');
    });

    it('несовпадение baseStatus → 409 conflict со снимком текущего статуса', async () => {
      const order = await createOrder();

      const response = await app.inject({
        method: 'POST',
        url: `/v1/orders/${order.id}/transition`,
        headers: authHeaders(dispatcherToken),
        payload: { to: 'InProgress', baseStatus: 'InProgress' },
      });

      expect(response.statusCode).toBe(409);
      const body = response.json<{ code: string; details?: { status?: string } }>();
      expect(body.code).toBe('conflict');
      expect(body.details?.status).toBe('New');
    });

    it('технику доступен переход только по своей заявке, иначе 404', async () => {
      const order = await createOrder();
      const owner = await seedUser('technician');
      const stranger = await seedUser('technician');
      const ownerToken = await loginAs(owner.email);
      const strangerToken = await loginAs(stranger.email);

      await app.inject({
        method: 'POST',
        url: `/v1/orders/${order.id}/assign`,
        headers: authHeaders(dispatcherToken),
        payload: { technicianId: owner.id },
      });

      const strangerAttempt = await app.inject({
        method: 'POST',
        url: `/v1/orders/${order.id}/transition`,
        headers: authHeaders(strangerToken),
        payload: { to: 'InProgress', baseStatus: 'New' },
      });
      expect(strangerAttempt.statusCode).toBe(404);

      const ownerAttempt = await app.inject({
        method: 'POST',
        url: `/v1/orders/${order.id}/transition`,
        headers: authHeaders(ownerToken),
        payload: { to: 'InProgress', baseStatus: 'New' },
      });
      expect(ownerAttempt.statusCode).toBe(200);
    });
  });

  describe('доступ по ролям и история событий (FR-03, FR-15)', () => {
    it('чужая заявка для технику → 404 (GET), список — только свои', async () => {
      const order = await createOrder();
      const owner = await seedUser('technician');
      const stranger = await seedUser('technician');
      const ownerToken = await loginAs(owner.email);
      const strangerToken = await loginAs(stranger.email);

      await app.inject({
        method: 'POST',
        url: `/v1/orders/${order.id}/assign`,
        headers: authHeaders(dispatcherToken),
        payload: { technicianId: owner.id },
      });

      const strangerGet = await app.inject({
        method: 'GET',
        url: `/v1/orders/${order.id}`,
        headers: authHeaders(strangerToken),
      });
      expect(strangerGet.statusCode).toBe(404);

      const ownerGet = await app.inject({
        method: 'GET',
        url: `/v1/orders/${order.id}`,
        headers: authHeaders(ownerToken),
      });
      expect(ownerGet.statusCode).toBe(200);
      const detail = ownerGet.json<{ id: string; photos: unknown[] }>();
      expect(detail.id).toBe(order.id);
      expect(detail.photos).toEqual([]);

      const strangerList = await app.inject({
        method: 'GET',
        url: '/v1/orders',
        headers: authHeaders(strangerToken),
      });
      expect(strangerList.statusCode).toBe(200);
      const strangerItems = strangerList.json<{ items: IOrderView[] }>().items;
      expect(strangerItems.some((item) => item.id === order.id)).toBe(false);

      const ownerList = await app.inject({
        method: 'GET',
        url: '/v1/orders',
        headers: authHeaders(ownerToken),
      });
      const ownerItems = ownerList.json<{ items: IOrderView[] }>().items;
      expect(ownerItems.some((item) => item.id === order.id)).toBe(true);
    });

    it('технику назначенный assignedTo из query игнорируется — видит только свои', async () => {
      const order = await createOrder();
      const owner = await seedUser('technician');
      const otherTechnician = await seedUser('technician');
      const ownerToken = await loginAs(owner.email);

      await app.inject({
        method: 'POST',
        url: `/v1/orders/${order.id}/assign`,
        headers: authHeaders(dispatcherToken),
        payload: { technicianId: owner.id },
      });

      const response = await app.inject({
        method: 'GET',
        url: `/v1/orders?assignedTo=${otherTechnician.id}`,
        headers: authHeaders(ownerToken),
      });

      expect(response.statusCode).toBe(200);
      const items = response.json<{ items: IOrderView[] }>().items;
      expect(items.some((item) => item.id === order.id)).toBe(true);
    });

    it('полная хронология событий восстанавливается (created, assigned, status_changed)', async () => {
      const order = await createOrder();
      const technician = await seedUser('technician');

      await app.inject({
        method: 'POST',
        url: `/v1/orders/${order.id}/assign`,
        headers: authHeaders(dispatcherToken),
        payload: { technicianId: technician.id },
      });
      await app.inject({
        method: 'POST',
        url: `/v1/orders/${order.id}/transition`,
        headers: authHeaders(dispatcherToken),
        payload: { to: 'InProgress', baseStatus: 'New' },
      });

      const response = await app.inject({
        method: 'GET',
        url: `/v1/orders/${order.id}`,
        headers: authHeaders(dispatcherToken),
      });

      expect(response.statusCode).toBe(200);
      const detail = response.json<{ events: { type: string }[] }>();
      expect(detail.events.map((event) => event.type)).toEqual([
        'created',
        'assigned',
        'status_changed',
      ]);
    });
  });
});
