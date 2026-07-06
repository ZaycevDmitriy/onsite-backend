import { drizzle } from 'drizzle-orm/node-postgres';
import { pino } from 'pino';

import { loadConfig } from '@/shared/config/index.js';
import { createPool } from '@/shared/db/index.js';

import { makeEphemeralJwtEnv } from './ephemeral-jwt-env.js';
import { runSeed } from './seed-data.js';

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
