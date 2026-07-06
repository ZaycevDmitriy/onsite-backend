import { hash } from '@node-rs/argon2';
import { eq, and, isNull } from 'drizzle-orm';

import { orderAssignments, orders } from '@/modules/orders/db-schema.js';
import { UserRoleEnum, users } from '@/modules/users/db-schema.js';

import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Logger } from 'pino';

// Фиксированные UUID сида: повторный запуск делает upsert, не дубликаты (FR-16).
export const SEED_USER_IDS = {
  dispatcher: '00000000-0000-4000-8000-000000000001',
  technician1: '00000000-0000-4000-8000-000000000002',
  technician2: '00000000-0000-4000-8000-000000000003',
} as const;

export const SEED_ORDER_IDS = [
  '00000000-0000-4000-8000-000000000101',
  '00000000-0000-4000-8000-000000000102',
  '00000000-0000-4000-8000-000000000103',
  '00000000-0000-4000-8000-000000000104',
  '00000000-0000-4000-8000-000000000105',
  '00000000-0000-4000-8000-000000000106',
] as const;

// Демо-учётки (документируются в README; данные не реальные — §9.1).
export const SEED_USERS = [
  {
    id: SEED_USER_IDS.dispatcher,
    email: 'dispatcher@onsite.local',
    password: 'dispatcher123',
    role: UserRoleEnum.Dispatcher,
    displayName: 'Диспетчер Демо',
  },
  {
    id: SEED_USER_IDS.technician1,
    email: 'tech1@onsite.local',
    password: 'technician123',
    role: UserRoleEnum.Technician,
    displayName: 'Техник Первый',
  },
  {
    id: SEED_USER_IDS.technician2,
    email: 'tech2@onsite.local',
    password: 'technician123',
    role: UserRoleEnum.Technician,
    displayName: 'Техник Второй',
  },
] as const;

// Шаблоны и локации зеркалят первые 6 записей mock.ts клиента (field-service-crm):
// пары «заголовок+описание» и «адрес+координаты» менять нельзя.
const ORDER_TEMPLATES = [
  {
    title: 'Установка роутера',
    description:
      'Установить и настроить Wi-Fi роутер у абонента. Проверить уровень сигнала в комнатах, выдать памятку по доступу к сети.',
  },
  {
    title: 'Замена маршрутизатора',
    description:
      'Демонтировать вышедший из строя маршрутизатор, установить новый. Перенести настройки сети и проверить стабильность подключения.',
  },
  {
    title: 'Настройка IPTV',
    description:
      'Подключить и настроить IPTV-приставку. Проверить воспроизведение каналов, обновить прошивку при необходимости.',
  },
  {
    title: 'Диагностика линии',
    description:
      'Найти причину обрывов связи на абонентской линии. Замерить параметры, при необходимости заменить участок кабеля.',
  },
  {
    title: 'Подключение интернета',
    description:
      'Завести оптический кабель в квартиру, установить ONT, настроить подключение по договору. Провести инструктаж абонента.',
  },
  {
    title: 'Ремонт кабеля',
    description:
      'Восстановить повреждённый участок кабеля в подъезде, восстановить связь у абонентов стояка. Зафиксировать результат фотоотчётом.',
  },
] as const;

const LOCATIONS = [
  { address: 'ул. Тверская, 15', latitude: 55.76233, longitude: 37.60797 },
  { address: 'Ленинградский пр-т, 36, кв. 45', latitude: 55.78818, longitude: 37.56687 },
  { address: 'ул. Профсоюзная, 64, кв. 12', latitude: 55.66643, longitude: 37.54759 },
  { address: 'Кутузовский пр-т, 26', latitude: 55.74392, longitude: 37.5438 },
  { address: 'Ленинский пр-т, 32, кв. 88', latitude: 55.7095, longitude: 37.58063 },
  { address: 'шоссе Энтузиастов, 24', latitude: 55.74785, longitude: 37.69789 },
] as const;

const CLIENTS = [
  'Иван Петров',
  'Ольга Соколова',
  'Сергей Кузнецов',
  'Марина Волкова',
  'Дмитрий Орлов',
  'Анна Морозова',
] as const;

// Формула времени mock.ts: 08:00 + ((index * 37) % 144) * 5 минут.
const WORK_DAY_START_MINUTES = 8 * 60;
const TIME_STEPS = 144;
const TIME_STEP_MULTIPLIER = 37;

// Назначения: заявки 1–2 → техник 1, 3–4 → техник 2, 5–6 не назначены.
const ASSIGNMENTS: Record<number, string> = {
  0: SEED_USER_IDS.technician1,
  1: SEED_USER_IDS.technician1,
  2: SEED_USER_IDS.technician2,
  3: SEED_USER_IDS.technician2,
};

const buildOrderTimes = (index: number): { scheduledAt: Date; slotStart: Date; slotEnd: Date } => {
  const startMinutes = WORK_DAY_START_MINUTES + ((index * TIME_STEP_MULTIPLIER) % TIME_STEPS) * 5;
  const slotStartHour = Math.floor(startMinutes / 60);

  // Даты — сегодня UTC: демо-заявки всегда «на сегодня»; upsert перезаписывает при повторе.
  const today = new Date();
  const atMinutes = (minutes: number): Date =>
    new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 0, minutes),
    );

  return {
    scheduledAt: atMinutes(startMinutes),
    slotStart: atMinutes(slotStartHour * 60),
    slotEnd: atMinutes((slotStartHour + 1) * 60),
  };
};

/**
 * Идемпотентный сид демо-данных (FR-16): 1 диспетчер, 2 техника, 6 заявок.
 * Upsert по фиксированным UUID (users дополнительно уникальны по email);
 * назначения создаются только при отсутствии активной записи.
 */
export const runSeed = async (db: NodePgDatabase, logger: Logger): Promise<void> => {
  logger.info('сид: старт');

  for (const seedUser of SEED_USERS) {
    // Argon2id (NFR-05); хеш пересчитывается при каждом запуске — стоимость приемлема для 3 учёток.
    const passwordHash = await hash(seedUser.password);

    await db
      .insert(users)
      .values({
        id: seedUser.id,
        email: seedUser.email,
        passwordHash,
        role: seedUser.role,
        displayName: seedUser.displayName,
      })
      .onConflictDoUpdate({
        target: users.id,
        set: { email: seedUser.email, role: seedUser.role, displayName: seedUser.displayName },
      });
    logger.debug({ email: seedUser.email, role: seedUser.role }, 'сид: пользователь');
  }

  for (const [index, orderId] of SEED_ORDER_IDS.entries()) {
    const template = ORDER_TEMPLATES[index] as (typeof ORDER_TEMPLATES)[number];
    const location = LOCATIONS[index] as (typeof LOCATIONS)[number];
    const client = CLIENTS[index] as (typeof CLIENTS)[number];
    const assignedTo = ASSIGNMENTS[index] ?? null;
    const times = buildOrderTimes(index);

    await db
      .insert(orders)
      .values({
        id: orderId,
        title: template.title,
        description: template.description,
        client,
        address: location.address,
        latitude: location.latitude,
        longitude: location.longitude,
        assignedTo,
        ...times,
      })
      .onConflictDoUpdate({
        target: orders.id,
        set: {
          title: template.title,
          description: template.description,
          client,
          address: location.address,
          assignedTo,
          ...times,
        },
      });

    // Активное назначение (unassigned_at IS NULL) создаётся один раз.
    if (assignedTo !== null) {
      const existing = await db
        .select({ id: orderAssignments.id })
        .from(orderAssignments)
        .where(
          and(
            eq(orderAssignments.orderId, orderId),
            eq(orderAssignments.userId, assignedTo),
            isNull(orderAssignments.unassignedAt),
          ),
        );

      if (existing.length === 0) {
        await db.insert(orderAssignments).values({ orderId, userId: assignedTo });
      }
    }

    logger.debug({ orderId, title: template.title, assignedTo }, 'сид: заявка');
  }

  logger.info(
    { users: SEED_USERS.length, orders: SEED_ORDER_IDS.length },
    'сид: завершён без дубликатов',
  );
};
