import { eq } from 'drizzle-orm';

import { users } from './db-schema.js';

import type { UserRoleEnum } from './db-schema.js';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

// Строка таблицы users как её видит Drizzle.
export type IUserRow = typeof users.$inferSelect;

// Транзакционный или обычный клиент Drizzle — locking-чтения вызываются из чужих транзакций.
export type DbClient = NodePgDatabase | Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0];

export interface IInsertUserInput {
  email: string;
  passwordHash: string;
  role: UserRoleEnum;
  displayName: string;
}

export interface IUpdateUserPatch {
  displayName?: string;
  isActive?: boolean;
  passwordHash?: string;
}

/** true, если в таблице есть хотя бы одна запись (bootstrap-проверка для create-first-user). */
export const selectAnyUserExists = async (db: NodePgDatabase): Promise<boolean> => {
  const rows = await db.select({ id: users.id }).from(users).limit(1);

  return rows.length > 0;
};

/** Ищет пользователя по id. */
export const findUserById = async (db: NodePgDatabase, id: string): Promise<IUserRow | null> => {
  const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);

  return rows[0] ?? null;
};

/**
 * Ищет пользователя по id с блокировкой строки (SELECT ... FOR SHARE).
 * Вызывать только внутри транзакции: конкурентный UPDATE строки ждёт её коммита.
 */
export const findUserByIdForShare = async (db: DbClient, id: string): Promise<IUserRow | null> => {
  const rows = await db.select().from(users).where(eq(users.id, id)).for('share').limit(1);

  return rows[0] ?? null;
};

/** Ищет пользователя по нормализованному email. */
export const findUserByEmail = async (
  db: NodePgDatabase,
  email: string,
): Promise<IUserRow | null> => {
  const rows = await db.select().from(users).where(eq(users.email, email)).limit(1);

  return rows[0] ?? null;
};

/** Вставляет нового пользователя и возвращает строку. */
export const insertUser = async (
  db: NodePgDatabase,
  input: IInsertUserInput,
): Promise<IUserRow> => {
  const rows = await db.insert(users).values(input).returning();

  // returning() по одной записи всегда отдаёт ровно одну строку.
  return rows[0] as IUserRow;
};

/** Обновляет пользователя по id; null — если не найден. */
export const updateUserById = async (
  db: NodePgDatabase,
  id: string,
  patch: IUpdateUserPatch,
): Promise<IUserRow | null> => {
  const rows = await db.update(users).set(patch).where(eq(users.id, id)).returning();

  return rows[0] ?? null;
};
