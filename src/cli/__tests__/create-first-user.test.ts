import { randomUUID } from 'node:crypto';

import { hash, verify } from '@node-rs/argon2';
import { like } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { users } from '@/modules/users/db-schema.js';
import { findAuthRecordByEmail } from '@/modules/users/index.js';
import { createPool } from '@/shared/db/index.js';

import { CreateFirstUserError, createFirstUser } from '../create-first-user-core.js';

import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

// Интеграционные тесты bootstrap-скрипта create-first-user (docs/deployment.md, «Первый запуск»):
// требуют реальной БД.
const databaseUrl = process.env.DATABASE_URL;
const logger = pino({ level: 'silent' });
const EMAIL_PREFIX = 'create-first-user-test-';

describe.runIf(databaseUrl)('createFirstUser', () => {
  describe('пустая таблица users', () => {
    let client: pg.Client;
    let db: NodePgDatabase;

    beforeAll(async () => {
      client = new pg.Client({ connectionString: databaseUrl });
      await client.connect();
      // TEMP-таблица shadow-ит public.users только для этого соединения (Postgres всегда ищет
      // pg_temp раньше search_path): изолирует тест от строк, которые параллельно создают
      // другие файлы тестов в общей БД, без риска для их данных.
      await client.query('CREATE TEMP TABLE users (LIKE public.users INCLUDING ALL)');
      db = drizzle(client);
    });

    afterAll(async () => {
      await client.end();
    });

    it('создаёт первого диспетчера', async () => {
      const email = `${EMAIL_PREFIX}${randomUUID()}@onsite.test`;
      const user = await createFirstUser(
        db,
        { email, password: 'first-dispatcher-secret', displayName: 'Первый Диспетчер' },
        logger,
      );

      expect(user.role).toBe('dispatcher');
      expect(user.isActive).toBe(true);
      expect(user.email).toBe(email);

      const authRecord = await findAuthRecordByEmail(db, email);
      expect(authRecord).not.toBeNull();
      expect(await verify(authRecord?.passwordHash as string, 'first-dispatcher-secret')).toBe(
        true,
      );
    });
  });

  describe('таблица users непуста / невалидный вход', () => {
    let pool: pg.Pool;
    let db: NodePgDatabase;

    beforeAll(() => {
      pool = createPool(databaseUrl as string);
      db = drizzle(pool);
    });

    afterAll(async () => {
      await db.delete(users).where(like(users.email, `${EMAIL_PREFIX}%`));
      await pool.end();
    });

    it('отказывает при уже существующей записи и не создаёт нового пользователя', async () => {
      const existingEmail = `${EMAIL_PREFIX}${randomUUID()}@onsite.test`;
      await db.insert(users).values({
        email: existingEmail,
        passwordHash: await hash('whatever-password'),
        role: 'technician',
        displayName: 'Уже есть',
      });

      const attemptedEmail = `${EMAIL_PREFIX}${randomUUID()}@onsite.test`;
      await expect(
        createFirstUser(
          db,
          { email: attemptedEmail, password: 'second-dispatcher-secret', displayName: 'Второй' },
          logger,
        ),
      ).rejects.toThrow(CreateFirstUserError);

      expect(await findAuthRecordByEmail(db, attemptedEmail)).toBeNull();
    });

    it('email, который отвергает loginBodySchema (не-ASCII), → отказ без создания записи', async () => {
      // Регрессия к ревью PR #7: CLI-regex либеральнее AJV format: 'email' позволял
      // создать аккаунт, под которым нельзя залогиниться (422 на /v1/auth/login).
      const email = 'иван@пример.рф';
      await expect(
        createFirstUser(
          db,
          { email, password: 'a-long-enough-password', displayName: 'Кто-то' },
          logger,
        ),
      ).rejects.toThrow(CreateFirstUserError);

      expect(await findAuthRecordByEmail(db, email)).toBeNull();
    });

    it('пустой email → отказ без создания записи', async () => {
      const email = '';
      await expect(
        createFirstUser(
          db,
          { email, password: 'a-long-enough-password', displayName: 'Кто-то' },
          logger,
        ),
      ).rejects.toThrow(CreateFirstUserError);
    });

    it('пароль короче 12 символов → отказ без создания записи', async () => {
      const email = `${EMAIL_PREFIX}${randomUUID()}@onsite.test`;
      await expect(
        createFirstUser(db, { email, password: 'short11ch', displayName: 'Кто-то' }, logger),
      ).rejects.toThrow(CreateFirstUserError);

      expect(await findAuthRecordByEmail(db, email)).toBeNull();
    });
  });
});
