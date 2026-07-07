# Onsite Backend

REST API для [Onsite](https://github.com/ZaycevDmitriy/field-service-crm) — мобильного mini-CRM выездных сервисных работников. Превращает офлайн-приложение в мультипользовательскую CRM: аутентификация с ролями, серверный реестр заявок с назначением на техников, протокол офлайн-синхронизации с идемпотентными мутациями, фотоотчёты и push-уведомления.

**Стек:** Node.js 24 · Fastify 5 (TypeBox) · PostgreSQL 16 (Drizzle) · MinIO/S3 · Docker Compose.

**Статус:** Фаза 3 — заявки: CRUD, назначение техников с историей (`order_assignments`), конечный автомат статусов (New → InProgress → Done, New/InProgress → Cancelled), append-only журнал событий (`order_events`). Плюс аутентификация фазы 2 (JWT RS256, роли `dispatcher`/`technician`).

## Быстрый старт

Весь стек (API + PostgreSQL + MinIO, миграции и сид применяются автоматически):

```bash
npx tsx scripts/generate-jwt-keys.ts >> .env   # пара ключей RS256 (однократно)
docker compose up
```

После старта:

- `http://localhost:3000/v1/health` — статус сервиса и зависимостей;
- `http://localhost:3000/docs` — OpenAPI UI.

Учётные данные в `compose.yml` (`onsite/onsite`, `minioadmin`) — демо-стек для локального запуска, не для продакшена.

### Локальная разработка без Docker

```bash
nvm use               # Node 24 из .nvmrc
npm ci
cp .env.example .env  # поправить DATABASE_URL при необходимости
npx tsx scripts/generate-jwt-keys.ts >> .env  # JWT_PRIVATE_KEY / JWT_PUBLIC_KEY
npm run migrate
npm run seed
npm run dev
```

## Аутентификация

- `POST /v1/auth/login` — логин по email/паролю, ответ — пара `accessToken` (JWT RS256, TTL `ACCESS_TOKEN_TTL_SEC`, по умолчанию 15 мин) + `refreshToken` (непрозрачный, TTL `REFRESH_TOKEN_TTL_SEC`, по умолчанию 30 дней). 5 неудач подряд — 429 на 15 минут.
- `POST /v1/auth/refresh` — ротация: старый токен гаснет, повторное использование погашенного отзывает всю семью сессий.
- `POST /v1/auth/logout` — отзыв семьи refresh-сессий.
- `POST /v1/users`, `PATCH /v1/users/:id` — управление аккаунтами (только роль `dispatcher`); сброс пароля отзывает все refresh-сессии пользователя; деактивация действует немедленно; диспетчер не может деактивировать сам себя.

Ключи RS256 задаются через env `JWT_PRIVATE_KEY`/`JWT_PUBLIC_KEY` (base64-кодированный PEM) — генерируются скриптом `scripts/generate-jwt-keys.ts`, в git не попадают.

## Заявки

- `GET /v1/orders` — список: диспетчер видит все (фильтры `status`, `assignedTo`, keyset-пагинация `cursor`/`limit`), техник — только свои (`assignedTo` из query игнорируется).
- `POST /v1/orders` — создание заявки (только `dispatcher`).
- `GET /v1/orders/:id` — заявка с фото (пусто до фазы 4) и полной историей событий; чужая заявка технику отвечает 404, не 403.
- `PATCH /v1/orders/:id` — правка полей (только `dispatcher`); статус меняется только через `transition`; заявка в `Done`/`Cancelled` → 409.
- `POST /v1/orders/:id/assign` — назначение/переназначение техника (только `dispatcher`); недопустимый статус заявки → 409; несуществующий, деактивированный или не-`technician` исполнитель → 422; повторное назначение того же техника — идемпотентно.
- `POST /v1/orders/:id/transition` — переход статуса (`dispatcher` — любая заявка, `technician` — только своя); недопустимый переход → 409 `invalid_transition` с текущим статусом в теле; несовпадение `baseStatus` со снимком клиента → 409 `conflict`.

Каждое изменение заявки (создание, назначение, переход статуса) пишется в append-only журнал `order_events` с актором и источником (`api`).

## Команды

| Команда                    | Назначение                                            |
| -------------------------- | ----------------------------------------------------- |
| `npm run dev`              | Запуск с hot-reload (tsx watch)                       |
| `npm run build`            | Сборка в `dist/` (tsc + tsc-alias)                    |
| `npm run typecheck`        | Проверка типов                                        |
| `npm run lint`             | ESLint                                                |
| `npm test`                 | Тесты (vitest); интеграционные требуют `DATABASE_URL` |
| `npm run test:coverage`    | Тесты с покрытием (v8)                                |
| `npm run migrate`          | Применить миграции (только вперёд)                    |
| `npm run seed`             | Идемпотентный сид демо-данных                         |
| `npm run db:generate`      | Сгенерировать миграцию из Drizzle-схем                |
| `npm run openapi:print`    | Напечатать OpenAPI-спеку в stdout                     |
| `npm run openapi:validate` | Проверить спеку против схемы OpenAPI 3.1              |

## Демо-учётки (сид)

| Роль      | Email                     | Пароль          |
| --------- | ------------------------- | --------------- |
| Диспетчер | `dispatcher@onsite.local` | `dispatcher123` |
| Техник    | `tech1@onsite.local`      | `technician123` |
| Техник    | `tech2@onsite.local`      | `technician123` |

Сид создаёт 6 демо-заявок, совместимых с mock-данными мобильного клиента. Все данные вымышленные.

## Лицензия

PolyForm Noncommercial 1.0.0 — см. [LICENSE](LICENSE).
