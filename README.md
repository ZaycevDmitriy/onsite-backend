# Onsite Backend

REST API для [Onsite](https://github.com/ZaycevDmitriy/field-service-crm) — мобильного mini-CRM выездных сервисных работников. Превращает офлайн-приложение в мультипользовательскую CRM: аутентификация с ролями, серверный реестр заявок с назначением на техников, протокол офлайн-синхронизации с идемпотентными мутациями, фотоотчёты и push-уведомления.

**Стек:** Node.js 24 · Fastify 5 (TypeBox) · PostgreSQL 16 (Drizzle) · MinIO/S3 · Docker Compose.

**Статус:** M0 — скелет проекта (Fastify + Drizzle + Compose + CI, `/v1/health`, OpenAPI, миграции, сид).

## Быстрый старт

Весь стек (API + PostgreSQL + MinIO, миграции и сид применяются автоматически):

```bash
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
npm run migrate
npm run seed
npm run dev
```

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
