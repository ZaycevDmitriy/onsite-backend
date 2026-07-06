import pg from 'pg';

// Таймауты: «зависшая» БД не должна подвешивать запросы (в т.ч. /v1/health) —
// быстрый отказ превращается в degraded-ответ, а не в бесконечное ожидание.
const CONNECTION_TIMEOUT_MS = 5_000;
const QUERY_TIMEOUT_MS = 5_000;

// Фабрика пула подключений PostgreSQL: используется приложением, миграциями и сидом.
export const createPool = (databaseUrl: string): pg.Pool =>
  new pg.Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
  });
