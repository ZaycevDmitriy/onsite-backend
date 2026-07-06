import pg from 'pg';

// Фабрика пула подключений PostgreSQL: используется приложением, миграциями и сидом.
export const createPool = (databaseUrl: string): pg.Pool =>
  new pg.Pool({ connectionString: databaseUrl });
