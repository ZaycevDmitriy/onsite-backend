import { eq } from 'drizzle-orm';

import { users } from './db-schema.js';

import type { UserRoleEnum } from './db-schema.js';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

// Строка таблицы users как её видит Drizzle.
export type IUserRow = typeof users.$inferSelect;

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

/** Ищет пользователя по id. */
export const findUserById = async (
  db: NodePgDatabase,
  id: string,
): Promise<IUserRow | null> => {
  const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);

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
