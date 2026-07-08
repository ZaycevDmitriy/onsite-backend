import { drizzle } from 'drizzle-orm/node-postgres';
import { pino } from 'pino';

import { makeEphemeralJwtEnv } from '@/cli/ephemeral-jwt-env.js';
import { loadConfig } from '@/shared/config/index.js';
import { createPool } from '@/shared/db/index.js';

import { runSeed } from './seed-data.js';

// Сид создаёт пользователей с фиксированными демо-паролями: против production-БД не запускается.
if (process.env.NODE_ENV === 'production') {
  process.stderr.write('Сид запрещён при NODE_ENV=production: демо-учётные данные не для прода.\n');
  process.exit(1);
}

// Defense-in-depth: даже без NODE_ENV сид допускает только локальные хосты БД dev-контура —
// запуск из dev-шелла с продовым DATABASE_URL отклоняется. Непарсируемый URL отдаётся loadConfig.
const ALLOWED_SEED_DB_HOSTS = new Set(['localhost', '127.0.0.1', 'postgres']);
const databaseUrl = process.env.DATABASE_URL;

if (
  databaseUrl !== undefined &&
  URL.canParse(databaseUrl) &&
  !ALLOWED_SEED_DB_HOSTS.has(new URL(databaseUrl).hostname)
) {
  process.stderr.write('Сид запрещён: хост БД не из локального dev-контура.\n');
  process.exit(1);
}

// Точка входа сида: npm run seed. JWT-ключи сиду не нужны — эпемерная пара для конфига.
const config = loadConfig({ ...makeEphemeralJwtEnv(), ...process.env });
const logger = pino({ level: config.logLevel });
const pool = createPool(config.databaseUrl);

try {
  await runSeed(drizzle(pool), logger);
} catch (error) {
  logger.error({ err: error }, 'ошибка сида');
  process.exitCode = 1;
} finally {
  await pool.end();
}
