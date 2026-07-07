import { randomUUID } from 'node:crypto';

import { hash } from '@node-rs/argon2';
import { inArray, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeTestConfig } from '@/__tests__/helpers/test-config.js';
import { buildApp } from '@/app.js';
import { refreshSessions } from '@/modules/auth/db-schema.js';
import { users } from '@/modules/users/db-schema.js';

import type { UserRoleEnum } from '@/modules/users/index.js';
import type { FastifyInstance } from 'fastify';

// Интеграционные тесты управления пользователями (FR-03, FR-04): требуют реальной БД.
const databaseUrl = process.env.DATABASE_URL;

const PASSWORD = 'dispatcher-secret-1';
const EMAIL_PREFIX = 'users-test-';

describe.runIf(databaseUrl)('управление пользователями', () => {
  let app: FastifyInstance;
  let dispatcherId: string;
  let dispatcherToken: string;
  let technicianToken: string;
  const createdUserIds: string[] = [];

  const seedUser = async (role: UserRoleEnum): Promise<{ id: string; email: string }> => {
    const id = randomUUID();
    const email = `${EMAIL_PREFIX}${id}@onsite.test`;
    await app.db.insert(users).values({
      id,
      email,
      passwordHash: await hash(PASSWORD),
      role,
      displayName: 'Тестовый Пользователь',
    });
    createdUserIds.push(id);

    return { id, email };
  };

  const loginAs = async (email: string, password = PASSWORD): Promise<string> => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password },
    });
    expect(response.statusCode).toBe(200);

    return response.json<{ accessToken: string }>().accessToken;
  };

  const authHeaders = (token: string): Record<string, string> => ({
    authorization: `Bearer ${token}`,
  });

  beforeAll(async () => {
    app = await buildApp(makeTestConfig(databaseUrl as string));
    await app.ready();

    const dispatcher = await seedUser('dispatcher');
    const technician = await seedUser('technician');
    dispatcherId = dispatcher.id;
    dispatcherToken = await loginAs(dispatcher.email);
    technicianToken = await loginAs(technician.email);
  });

  afterAll(async () => {
    // Зачистка: созданные через API пользователи находятся по префиксу email.
    const testUsers = await app.db
      .select({ id: users.id })
      .from(users)
      .where(like(users.email, `${EMAIL_PREFIX}%`));
    const ids = [...new Set([...createdUserIds, ...testUsers.map((row) => row.id)])];

    if (ids.length > 0) {
      await app.db.delete(refreshSessions).where(inArray(refreshSessions.userId, ids));
      await app.db.delete(users).where(inArray(users.id, ids));
    }
    await app.close();
  });

  it('диспетчер создаёт техника, и тот логинится (FR-04)', async () => {
    const email = `${EMAIL_PREFIX}${randomUUID()}@onsite.test`;
    const response = await app.inject({
      method: 'POST',
      url: '/v1/users',
      headers: authHeaders(dispatcherToken),
      payload: {
        email,
        password: 'new-tech-password',
        role: 'technician',
        displayName: 'Новый Техник',
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<{ id: string; email: string }>();
    expect(body.email).toBe(email);
    expect(response.body).not.toContain('passwordHash');

    await loginAs(email, 'new-tech-password');
  });

  it('повторный email → 409 email_taken', async () => {
    const existing = await seedUser('technician');
    const response = await app.inject({
      method: 'POST',
      url: '/v1/users',
      headers: authHeaders(dispatcherToken),
      payload: {
        email: existing.email,
        password: 'whatever-pass',
        role: 'technician',
        displayName: 'Дубликат',
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('email_taken');
  });

  it('под ролью technician → 403 forbidden (FR-03)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/users',
      headers: authHeaders(technicianToken),
      payload: {
        email: `${EMAIL_PREFIX}${randomUUID()}@onsite.test`,
        password: 'whatever-pass',
        role: 'technician',
        displayName: 'Не должен создаться',
      },
    });

    expect(response.statusCode).toBe(403);
  });

  it('без токена → 401', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/users',
      payload: {
        email: `${EMAIL_PREFIX}${randomUUID()}@onsite.test`,
        password: 'whatever-pass',
        role: 'technician',
        displayName: 'Аноним',
      },
    });

    expect(response.statusCode).toBe(401);
  });

  it('деактивация действует немедленно: 401 при валидном access (FR-04)', async () => {
    const target = await seedUser('technician');
    const targetToken = await loginAs(target.email);

    const patch = await app.inject({
      method: 'PATCH',
      url: `/v1/users/${target.id}`,
      headers: authHeaders(dispatcherToken),
      payload: { isActive: false },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json<{ isActive: boolean }>().isActive).toBe(false);

    // Access-токен ещё в пределах TTL, но пользователь деактивирован.
    const denied = await app.inject({
      method: 'POST',
      url: '/v1/users',
      headers: authHeaders(targetToken),
      payload: {
        email: `${EMAIL_PREFIX}${randomUUID()}@onsite.test`,
        password: 'whatever-pass',
        role: 'technician',
        displayName: 'Не пройдёт',
      },
    });
    expect(denied.statusCode).toBe(401);
  });

  it('диспетчер не может деактивировать сам себя → 422 (guard самодеактивации)', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/users/${dispatcherId}`,
      headers: authHeaders(dispatcherToken),
      payload: { isActive: false },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ code: string }>().code).toBe('validation_failed');

    // Диспетчер остаётся активным и продолжает работать своим токеном.
    const stillWorks = await app.inject({
      method: 'PATCH',
      url: `/v1/users/${dispatcherId}`,
      headers: authHeaders(dispatcherToken),
      payload: { displayName: 'Всё ещё диспетчер' },
    });
    expect(stillWorks.statusCode).toBe(200);
    expect(stillWorks.json<{ isActive: boolean }>().isActive).toBe(true);
  });

  it('диспетчер деактивирует другого диспетчера — guard не мешает (только self)', async () => {
    const otherDispatcher = await seedUser('dispatcher');

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/users/${otherDispatcher.id}`,
      headers: authHeaders(dispatcherToken),
      payload: { isActive: false },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ isActive: boolean }>().isActive).toBe(false);
  });

  it('сброс пароля отзывает refresh-сессии: прежний refresh → 401 (FR-04)', async () => {
    const target = await seedUser('technician');
    const loginResponse = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: target.email, password: PASSWORD },
    });
    const { refreshToken } = loginResponse.json<{ refreshToken: string }>();

    const patch = await app.inject({
      method: 'PATCH',
      url: `/v1/users/${target.id}`,
      headers: authHeaders(dispatcherToken),
      payload: { password: 'brand-new-password' },
    });
    expect(patch.statusCode).toBe(200);

    const refreshAttempt = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken },
    });
    expect(refreshAttempt.statusCode).toBe(401);

    // Новый пароль работает.
    await loginAs(target.email, 'brand-new-password');
  });

  it('несуществующий пользователь → 404', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/users/${randomUUID()}`,
      headers: authHeaders(dispatcherToken),
      payload: { displayName: 'Никто' },
    });

    expect(response.statusCode).toBe(404);
  });

  it('невалидное тело → 422 validation_failed', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/users',
      headers: authHeaders(dispatcherToken),
      payload: { email: 'not-an-email', password: 'short', role: 'boss', displayName: '' },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ code: string }>().code).toBe('validation_failed');
  });
});
