import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { pino } from 'pino';

import { loadConfig } from '@/shared/config/index.js';
import { createPool } from '@/shared/db/index.js';

import { makeEphemeralJwtEnv } from './ephemeral-jwt-env.js';

// Раннер миграций: только вперёд, каталог drizzle/ — единственный источник DDL.
// JWT-ключи миграциям не нужны: эпемерная пара только для валидации конфига.
const config = loadConfig({ ...makeEphemeralJwtEnv(), ...process.env });
const logger = pino({ level: config.logLevel });

const pool = createPool(config.databaseUrl);
const db = drizzle(pool);

logger.info('запуск миграций');

try {
  await migrate(db, { migrationsFolder: './drizzle' });
  logger.info('миграции применены');
} catch (error) {
  logger.error({ err: error }, 'ошибка применения миграций');
  process.exitCode = 1;
} finally {
  await pool.end();
}
