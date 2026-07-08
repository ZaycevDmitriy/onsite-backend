import { drizzle } from 'drizzle-orm/node-postgres';
import { pino } from 'pino';

import { loadConfig } from '@/shared/config/index.js';
import { createPool } from '@/shared/db/index.js';

import { CreateFirstUserError, createFirstUser } from './create-first-user-core.js';
import { makeEphemeralJwtEnv } from './ephemeral-jwt-env.js';

// Bootstrap-скрипт первичной инициализации прода (docs/deployment.md, «Первый запуск»):
// создаёт первого диспетчера, если таблица users пуста. JWT-ключи не нужны — эпемерная
// пара только для валидации конфига (как в migrate.ts).
const config = loadConfig({ ...makeEphemeralJwtEnv(), ...process.env });
const logger = pino({ level: config.logLevel });

// Вход только через env: позиционные argv не принимаются — аргументы командной строки
// видны всем пользователям хоста через ps / /proc/<pid>/cmdline (CWE-214), env — нет.
const email = process.env.FIRST_USER_EMAIL;
const password = process.env.FIRST_USER_PASSWORD;
const displayName = process.env.FIRST_USER_NAME ?? 'Диспетчер';

if (email === undefined || password === undefined) {
  logger.error(
    'использование: FIRST_USER_EMAIL=... FIRST_USER_PASSWORD=... [FIRST_USER_NAME=...] node dist/cli/create-first-user.js',
  );
  process.exit(1);
}

const pool = createPool(config.databaseUrl);
const db = drizzle(pool);

try {
  const user = await createFirstUser(db, { email, password, displayName }, logger);
  logger.info({ id: user.id, email: user.email, role: user.role }, 'первый диспетчер создан');
} catch (error) {
  if (error instanceof CreateFirstUserError) {
    logger.error({ reason: error.message }, 'создание первого пользователя отклонено');
  } else {
    logger.error({ err: error }, 'ошибка создания первого пользователя');
  }
  process.exitCode = 1;
} finally {
  await pool.end();
}
