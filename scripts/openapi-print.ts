import { buildApp } from '@/app.js';
import { loadConfig } from '@/shared/config/index.js';

// Печатает OpenAPI-спеку в stdout: используется CI для валидации контракта.
// БД не нужна: подключение ленивое, схема собирается из зарегистрированных роутов.
const config = loadConfig({
  ...process.env,
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://unused:unused@localhost:5432/unused',
  LOG_LEVEL: 'fatal',
});

const app = await buildApp(config);
await app.ready();

process.stdout.write(JSON.stringify(app.swagger(), null, 2));
process.stdout.write('\n');

await app.close();
