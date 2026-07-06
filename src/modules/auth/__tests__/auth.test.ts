import { randomUUID } from 'node:crypto';

import { hash } from '@node-rs/argon2';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeTestConfig } from '@/__tests__/helpers/test-config.js';
import { buildApp } from '@/app.js';
import { refreshSessions } from '@/modules/auth/db-schema.js';
import { users } from '@/modules/users/db-schema.js';

import type { UserRoleEnum } from '@/modules/users/index.js';
import type { FastifyInstance } from 'fastify';

// Интеграционные тесты auth-флоу (FR-01, FR-02): требуют реальной БД с миграциями.
const databaseUrl = process.env.DATABASE_URL;

const PASSWORD = 'correct-horse-battery';

describe.runIf(databaseUrl)('auth-флоу', () => {
  let app: FastifyInstance;
  const createdUserIds: string[] = [];

  const createTestUser = async (
    role: UserRoleEnum = 'technician',
    isActive = true,
  ): Promise<{ id: string; email: string }> => {
    const id = randomUUID();
    const email = `auth-test-${id}@onsite.test`;
    await app.db.insert(users).values({
      id,
      email,
      passwordHash: await hash(PASSWORD),
      role,
      displayName: 'Тестовый Пользователь',
      isActive,
    });
    createdUserIds.push(id);

    return { id, email };
  };

  const login = async (email: string, password: string) =>
    app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password } });

  const refresh = async (refreshToken: string) =>
    app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken } });

  beforeAll(async () => {
    app = await buildApp(makeTestConfig(databaseUrl as string));
    await app.ready();
  });

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      await app.db.delete(refreshSessions).where(inArray(refreshSessions.userId, createdUserIds));
      await app.db.delete(users).where(inArray(users.id, createdUserIds));
    }
    await app.close();
  });

  it('верный логин → 200 с парой токенов (FR-01)', async () => {
    const user = await createTestUser();
    const response = await login(user.email, PASSWORD);

    expect(response.statusCode).toBe(200);
    const body = response.json<{ accessToken: string; refreshToken: string }>();
    expect(body.accessToken).toBeTruthy();
    expect(body.refreshToken).toBeTruthy();
  });

  it('неверный пароль и несуществующий email → одинаковый 401 invalid_credentials', async () => {
    const user = await createTestUser();

    const wrongPassword = await login(user.email, 'wrong-password');
    const unknownEmail = await login(`ghost-${randomUUID()}@onsite.test`, PASSWORD);

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(401);
    expect(wrongPassword.json()).toEqual(unknownEmail.json());
    expect(wrongPassword.json<{ code: string }>().code).toBe('invalid_credentials');
  });

  it('5 неудач подряд → 429 too_many_attempts, даже с верным паролем (FR-01)', async () => {
    const user = await createTestUser();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await login(user.email, 'wrong-password');
      expect(response.statusCode).toBe(401);
    }

    const locked = await login(user.email, PASSWORD);
    expect(locked.statusCode).toBe(429);
    expect(locked.json<{ code: string }>().code).toBe('too_many_attempts');
  });

  it('ротация: refresh выдаёт новую пару, старый токен гаснет', async () => {
    const user = await createTestUser();
    const loginBody = (await login(user.email, PASSWORD)).json<{ refreshToken: string }>();

    const rotated = await refresh(loginBody.refreshToken);
    expect(rotated.statusCode).toBe(200);
    const rotatedBody = rotated.json<{ accessToken: string; refreshToken: string }>();
    expect(rotatedBody.refreshToken).not.toBe(loginBody.refreshToken);

    // Новый токен рабочий.
    const second = await refresh(rotatedBody.refreshToken);
    expect(second.statusCode).toBe(200);
  });

  it('replay погашенного токена → 401 и отзыв всей семьи (FR-02)', async () => {
    const user = await createTestUser();
    const loginBody = (await login(user.email, PASSWORD)).json<{ refreshToken: string }>();

    const rotated = await refresh(loginBody.refreshToken);
    const rotatedBody = rotated.json<{ refreshToken: string }>();

    // Replay старого токена.
    const replay = await refresh(loginBody.refreshToken);
    expect(replay.statusCode).toBe(401);

    // Семья отозвана: свежий токен той же цепочки тоже 401.
    const afterReplay = await refresh(rotatedBody.refreshToken);
    expect(afterReplay.statusCode).toBe(401);
  });

  it('logout отзывает семью: прежний refresh → 401', async () => {
    const user = await createTestUser();
    const loginBody = (await login(user.email, PASSWORD)).json<{ refreshToken: string }>();

    const logout = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      payload: { refreshToken: loginBody.refreshToken },
    });
    expect(logout.statusCode).toBe(204);

    const afterLogout = await refresh(loginBody.refreshToken);
    expect(afterLogout.statusCode).toBe(401);
  });

  it('просроченный refresh → 401', async () => {
    const user = await createTestUser();
    const loginBody = (await login(user.email, PASSWORD)).json<{ refreshToken: string }>();

    // Просрочка выставляется напрямую в БД: TTL конфига трогать не нужно.
    await app.db
      .update(refreshSessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(refreshSessions.userId, user.id));

    const expired = await refresh(loginBody.refreshToken);
    expect(expired.statusCode).toBe(401);
  });
});
