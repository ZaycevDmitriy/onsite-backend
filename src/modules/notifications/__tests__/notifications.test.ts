import { randomUUID } from 'node:crypto';

import { hash } from '@node-rs/argon2';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeTestConfig } from '@/__tests__/helpers/test-config.js';
import { buildApp } from '@/app.js';
import { refreshSessions } from '@/modules/auth/db-schema.js';
import { devices } from '@/modules/notifications/db-schema.js';
import { users } from '@/modules/users/db-schema.js';

import type { UserRoleEnum } from '@/modules/users/index.js';
import type { FastifyInstance } from 'fastify';

// Интеграционные тесты регистрации устройств (FR-13): требуют реальной БД.
const databaseUrl = process.env.DATABASE_URL;

const PASSWORD = 'technician-secret-1';
const EMAIL_PREFIX = 'devices-test-';

const makeExpoPushToken = (): string => `ExponentPushToken[${randomUUID().replace(/-/g, '')}]`;

describe.runIf(databaseUrl)('регистрация устройств', () => {
  let app: FastifyInstance;
  const createdUserIds: string[] = [];

  const seedUser = async (role: UserRoleEnum): Promise<{ id: string; email: string }> => {
    const id = randomUUID();
    const email = `${EMAIL_PREFIX}${id}@onsite.test`;
    await app.db.insert(users).values({
      id,
      email,
      passwordHash: await hash(PASSWORD),
      role,
      displayName: 'Тестовый Техник',
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

  beforeAll(async () => {
    app = await buildApp(makeTestConfig(databaseUrl as string));
    await app.ready();
  });

  afterAll(async () => {
    await app.db.delete(devices).where(inArray(devices.userId, createdUserIds));
    await app.db.delete(refreshSessions).where(inArray(refreshSessions.userId, createdUserIds));
    await app.db.delete(users).where(inArray(users.id, createdUserIds));
    await app.close();
  });

  it('регистрирует новое устройство (FR-13)', async () => {
    const technician = await seedUser('technician');
    const token = await loginAs(technician.email);
    const expoPushToken = makeExpoPushToken();

    const response = await app.inject({
      method: 'PUT',
      url: '/v1/devices',
      headers: authHeaders(token),
      payload: { expoPushToken },
    });

    expect(response.statusCode).toBe(204);

    const rows = await app.db.select().from(devices).where(eq(devices.expoPushToken, expoPushToken));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(technician.id);
    expect(rows[0]?.isActive).toBe(true);
  });

  it('повторная регистрация того же токена тем же пользователем — upsert, без дублей', async () => {
    const technician = await seedUser('technician');
    const token = await loginAs(technician.email);
    const expoPushToken = makeExpoPushToken();

    await app.inject({
      method: 'PUT',
      url: '/v1/devices',
      headers: authHeaders(token),
      payload: { expoPushToken },
    });
    const second = await app.inject({
      method: 'PUT',
      url: '/v1/devices',
      headers: authHeaders(token),
      payload: { expoPushToken },
    });

    expect(second.statusCode).toBe(204);

    const rows = await app.db.select().from(devices).where(eq(devices.expoPushToken, expoPushToken));
    expect(rows).toHaveLength(1);
  });

  it('тот же токен от другого пользователя — перепривязка (решение #8 фазы 6)', async () => {
    const firstOwner = await seedUser('technician');
    const secondOwner = await seedUser('technician');
    const expoPushToken = makeExpoPushToken();

    await app.inject({
      method: 'PUT',
      url: '/v1/devices',
      headers: authHeaders(await loginAs(firstOwner.email)),
      payload: { expoPushToken },
    });
    const rebind = await app.inject({
      method: 'PUT',
      url: '/v1/devices',
      headers: authHeaders(await loginAs(secondOwner.email)),
      payload: { expoPushToken },
    });

    expect(rebind.statusCode).toBe(204);

    const rows = await app.db.select().from(devices).where(eq(devices.expoPushToken, expoPushToken));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(secondOwner.id);
  });

  it('невалидный формат токена → 422 validation_failed', async () => {
    const technician = await seedUser('technician');
    const token = await loginAs(technician.email);

    const response = await app.inject({
      method: 'PUT',
      url: '/v1/devices',
      headers: authHeaders(token),
      payload: { expoPushToken: 'not-an-expo-token' },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ code: string }>().code).toBe('validation_failed');
  });

  it('без токена → 401', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/v1/devices',
      payload: { expoPushToken: makeExpoPushToken() },
    });

    expect(response.statusCode).toBe(401);
  });

  it('пустой expoPushToken → 422 validation_failed (схема)', async () => {
    const technician = await seedUser('technician');
    const token = await loginAs(technician.email);

    const response = await app.inject({
      method: 'PUT',
      url: '/v1/devices',
      headers: authHeaders(token),
      payload: { expoPushToken: '' },
    });

    expect(response.statusCode).toBe(422);
  });
});
