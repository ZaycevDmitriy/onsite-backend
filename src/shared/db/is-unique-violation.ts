// Код unique-констрейнта PostgreSQL.
const PG_UNIQUE_VIOLATION = '23505';

/**
 * Проверяет, что ошибка (или её cause) — нарушение unique-констрейнта PostgreSQL.
 * Drizzle оборачивает ошибки pg: код ищется по цепочке error.cause.
 */
export const isUniqueViolation = (error: unknown): boolean => {
  for (let current = error; current instanceof Error; current = current.cause) {
    if ((current as { code?: unknown }).code === PG_UNIQUE_VIOLATION) {
      return true;
    }
  }

  return false;
};
