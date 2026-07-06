import { sql } from 'drizzle-orm';
import { boolean, check, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

// Роли пользователей системы.
export const UserRoleEnum = {
  Dispatcher: 'dispatcher',
  Technician: 'technician',
} as const;
export type UserRoleEnum = (typeof UserRoleEnum)[keyof typeof UserRoleEnum];

// Аккаунты: создаются диспетчером или сидом, самостоятельной регистрации нет.
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull().unique(),
    // Хеш argon2id (NFR-05); сам пароль нигде не хранится и не логируется.
    passwordHash: text('password_hash').notNull(),
    role: text('role', { enum: [UserRoleEnum.Dispatcher, UserRoleEnum.Technician] }).notNull(),
    displayName: text('display_name').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check('users_role_check', sql`${table.role} in ('dispatcher', 'technician')`)],
);
