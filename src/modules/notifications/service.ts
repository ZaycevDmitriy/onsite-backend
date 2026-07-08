import { Expo } from 'expo-server-sdk';

import { isUniqueViolation } from '@/shared/db/index.js';
import { AppError, ErrorCodeEnum } from '@/shared/errors/index.js';

import { enqueuePush, findDeviceByToken, insertDevice, updateDeviceOwner } from './repository.js';

import type { DbClient } from './repository.js';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { FastifyBaseLogger } from 'fastify';

export interface IRegisterDeviceInput {
  expoPushToken: string;
}

// Заявитель операции: id пользователя из request.user (authPlugin).
export interface IDeviceRequester {
  id: string;
}

export interface IEnqueueAssignmentPushInput {
  userId: string;
  orderId: string;
  orderTitle: string;
  scheduledAt: string;
}

/**
 * Регистрирует push-токен устройства (FR-13): upsert по expo_push_token (уникален глобально).
 * Тот же токен от другого пользователя — легитимная перепривязка при re-login на новом
 * аккаунте (решение #8 фазы 6): устройство переходит новому владельцу и реактивируется,
 * событие логируется warn (осознанное исключение из правила скоупинга клиентских ключей).
 */
export const registerDevice = async (
  db: NodePgDatabase,
  input: IRegisterDeviceInput,
  requester: IDeviceRequester,
  logger: FastifyBaseLogger,
): Promise<void> => {
  logger.debug({ userId: requester.id }, 'регистрация устройства: старт');

  if (!Expo.isExpoPushToken(input.expoPushToken)) {
    logger.debug('регистрация устройства отклонена: невалидный формат ExpoPushToken');
    throw new AppError(422, ErrorCodeEnum.ValidationFailed, 'Invalid Expo push token format');
  }

  const existing = await findDeviceByToken(db, input.expoPushToken);

  if (existing !== null) {
    const rebound = existing.userId !== requester.id;

    await updateDeviceOwner(db, existing.id, requester.id);

    if (rebound) {
      logger.warn(
        { deviceId: existing.id, previousUserId: existing.userId, userId: requester.id },
        'регистрация устройства: перепривязка токена другому пользователю',
      );
    } else {
      logger.info(
        { deviceId: existing.id, userId: requester.id },
        'регистрация устройства: реактивация существующей записи',
      );
    }

    return;
  }

  try {
    const row = await insertDevice(db, {
      userId: requester.id,
      expoPushToken: input.expoPushToken,
    });
    logger.info({ deviceId: row.id, userId: requester.id }, 'устройство зарегистрировано');
  } catch (error) {
    if (isUniqueViolation(error)) {
      // Гонка конкурентной регистрации того же токена: перечитать и перепривязать (решение #8).
      const raced = await findDeviceByToken(db, input.expoPushToken);

      if (raced !== null) {
        await updateDeviceOwner(db, raced.id, requester.id);
        logger.info(
          { deviceId: raced.id, userId: requester.id },
          'регистрация устройства: гонка конкурентной вставки, перепривязано',
        );

        return;
      }
    }

    logger.error({ err: error }, 'ошибка регистрации устройства');
    throw error;
  }
};

/**
 * Кладёт push о назначении заявки в outbox (FR-14, решение #3 фазы 6): вызывается ИНЪЕКЦИЕЙ
 * ВНУТРИ транзакции assignOrder (orders, паттерн revokeAllUserSessions) — outbox атомарен
 * с самим назначением. Сама отправка в Expo — вне критического пути, её делает push-worker.
 */
export const enqueueAssignmentPush = async (
  db: DbClient,
  input: IEnqueueAssignmentPushInput,
  logger: FastifyBaseLogger,
): Promise<void> => {
  const message = {
    title: 'Новая заявка назначена',
    body: `${input.orderTitle} — визит ${input.scheduledAt}`,
    data: { type: 'order_assigned', orderId: input.orderId },
  };

  await enqueuePush(db, { userId: input.userId, message });

  logger.debug(
    { userId: input.userId, orderId: input.orderId },
    'push о назначении поставлен в очередь outbox',
  );
};
