import { UserRoleEnum, createUser, hasAnyUsers } from '@/modules/users/index.js';

import type { ICreateUserInput, IUserView } from '@/modules/users/index.js';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { FastifyBaseLogger } from 'fastify';

export interface ICreateFirstUserInput {
  email: string;
  password: string;
  displayName: string;
}

// Отдельный тип ошибки: entrypoint отличает «отказ по бизнес-правилу» (лог без стектрейса)
// от неожиданной ошибки БД/сети (лог с err).
export class CreateFirstUserError extends Error {}

// Зеркало createUserBodySchema (src/modules/users/schemas.ts) — CLI не проходит через
// Fastify/TypeBox-валидацию тела запроса, поэтому границы проверяются вручную.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_MIN_LENGTH = 3;
const EMAIL_MAX_LENGTH = 320;
const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_LENGTH = 1024;
const DISPLAY_NAME_MIN_LENGTH = 1;
const DISPLAY_NAME_MAX_LENGTH = 200;

const validateInput = (input: ICreateFirstUserInput): void => {
  const { email, password, displayName } = input;

  if (
    email.length < EMAIL_MIN_LENGTH ||
    email.length > EMAIL_MAX_LENGTH ||
    !EMAIL_REGEX.test(email)
  ) {
    throw new CreateFirstUserError('Некорректный email');
  }

  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    throw new CreateFirstUserError(
      `Пароль должен быть от ${PASSWORD_MIN_LENGTH} до ${PASSWORD_MAX_LENGTH} символов`,
    );
  }

  if (
    displayName.length < DISPLAY_NAME_MIN_LENGTH ||
    displayName.length > DISPLAY_NAME_MAX_LENGTH
  ) {
    throw new CreateFirstUserError('Некорректное отображаемое имя');
  }
};

/**
 * Создаёт первого диспетчера при пустой таблице users — единственный способ завести
 * аккаунт без ручного INSERT в проде (самостоятельной регистрации в API нет, docs/deployment.md).
 * Непустая таблица users → отказ: скрипт только для первичной инициализации.
 */
export const createFirstUser = async (
  db: NodePgDatabase,
  input: ICreateFirstUserInput,
  logger: FastifyBaseLogger,
): Promise<IUserView> => {
  validateInput(input);

  if (await hasAnyUsers(db)) {
    logger.error('в users уже есть записи: create-first-user только для первичной инициализации');
    throw new CreateFirstUserError('В таблице users уже есть записи');
  }

  const createInput: ICreateUserInput = {
    email: input.email,
    password: input.password,
    role: UserRoleEnum.Dispatcher,
    displayName: input.displayName,
  };

  return createUser(db, createInput, logger);
};
