import { createHash, randomUUID } from 'node:crypto';

import { hash } from '@node-rs/argon2';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeTestConfig } from '@/__tests__/helpers/test-config.js';
import { buildApp } from '@/app.js';
import { users } from '@/modules/users/db-schema.js';

import { refreshSessions } from '../db-schema.js';
import { cleanupExpiredSessions } from '../service.js';

import type { FastifyInstance } from 'fastify';

// Интеграционные тесты зачистки просроченных refresh_sessions (план: feature-refresh-sessions-cleanup).
const databaseUrl = process.env.DATABASE_URL;

describe.runIf(databaseUrl)('зачистка просроченных refresh-сессий', () => {
  let app: FastifyInstance;
  const createdUserIds: string[] = [];

  const createTestUser = async (): Promise<string> => {
    const id = randomUUID();
    await app.db.insert(users).values({
      id,
      email: `session-cleanup-${id}@onsite.test`,
      passwordHash: await hash('correct-horse-battery'),
      role: 'technician',
      displayName: 'Тестовый Пользователь',
      isActive: true,
    });
    createdUserIds.push(id);

    return id;
  };

  const insertSession = async (
    userId: string,
    expiresAt: Date,
    revokedAt: Date | null = null,
  ): Promise<string> => {
    const id = randomUUID();
    await app.db.insert(refreshSessions).values({
      id,
      userId,
      tokenHash: createHash('sha256').update(id).digest('hex'),
      familyId: randomUUID(),
      expiresAt,
      revokedAt,
    });

    return id;
  };

  const daysFromNow = (days: number): Date => new Date(Date.now() + days * 24 * 60 * 60 * 1000);

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

  it('удаляет сессию, просроченную дольше grace-периода', async () => {
    const userId = await createTestUser();
    const sessionId = await insertSession(userId, daysFromNow(-8));

    await cleanupExpiredSessions(app.db, 7, app.log);

    const rows = await app.db
      .select()
      .from(refreshSessions)
      .where(eq(refreshSessions.id, sessionId));
    expect(rows).toHaveLength(0);
  });

  it('сохраняет просроченную сессию внутри grace-периода', async () => {
    const userId = await createTestUser();
    const sessionId = await insertSession(userId, daysFromNow(-3));

    await cleanupExpiredSessions(app.db, 7, app.log);

    const rows = await app.db
      .select()
      .from(refreshSessions)
      .where(eq(refreshSessions.id, sessionId));
    expect(rows).toHaveLength(1);
  });

  it('сохраняет живую отозванную сессию (replay-детекция)', async () => {
    const userId = await createTestUser();
    const sessionId = await insertSession(userId, daysFromNow(30), new Date());

    await cleanupExpiredSessions(app.db, 7, app.log);

    const rows = await app.db
      .select()
      .from(refreshSessions)
      .where(eq(refreshSessions.id, sessionId));
    expect(rows).toHaveLength(1);
  });

  it('удаляет все просроченные сессии за несколько батчей (250 строк)', async () => {
    const userId = await createTestUser();
    const total = 250;

    await Promise.all(Array.from({ length: total }, () => insertSession(userId, daysFromNow(-8))));

    const deleted = await cleanupExpiredSessions(app.db, 7, app.log);

    expect(deleted).toBe(total);

    const remaining = await app.db
      .select()
      .from(refreshSessions)
      .where(eq(refreshSessions.userId, userId));
    expect(remaining).toHaveLength(0);
  });
});
