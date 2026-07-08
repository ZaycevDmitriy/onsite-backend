import { Validator } from '@seriousme/openapi-schema-validator';
import { pino } from 'pino';

import { buildApp } from '@/app.js';
import { makeEphemeralJwtEnv } from '@/cli/ephemeral-jwt-env.js';
import { loadConfig } from '@/shared/config/index.js';

// Валидация OpenAPI-спеки против схемы OpenAPI 3.1 (шаг CI).
const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

const config = loadConfig({
  ...makeEphemeralJwtEnv(),
  ...process.env,
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://unused:unused@localhost:5432/unused',
  LOG_LEVEL: 'fatal',
});

const app = await buildApp(config);
await app.ready();

const spec = app.swagger();
await app.close();

const validator = new Validator();
const result = await validator.validate(
  JSON.parse(JSON.stringify(spec)) as Record<string, unknown>,
);

if (!result.valid) {
  logger.error({ errors: result.errors }, 'OpenAPI-спека невалидна');
  process.exit(1);
}

logger.info('OpenAPI-спека валидна');
