import { defineConfig } from 'drizzle-kit';

// Схема собирается из db-schema.ts всех модулей: таблицей владеет один модуль.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/modules/*/db-schema.ts',
  out: './drizzle',
  dbCredentials: {
    // Только для drizzle-kit CLI; приложение читает env через shared/config.
    url: process.env.DATABASE_URL ?? 'postgres://onsite:onsite@localhost:5432/onsite',
  },
});
