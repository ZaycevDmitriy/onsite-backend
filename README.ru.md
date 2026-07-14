# Onsite Backend

[![CI](https://github.com/ZaycevDmitriy/onsite-backend/actions/workflows/ci.yml/badge.svg)](https://github.com/ZaycevDmitriy/onsite-backend/actions/workflows/ci.yml)
[![Release](https://github.com/ZaycevDmitriy/onsite-backend/actions/workflows/release.yml/badge.svg)](https://github.com/ZaycevDmitriy/onsite-backend/actions/workflows/release.yml)

[English](README.md) · **Русский**

> **Для рекрутёров (TL;DR)**
>
> - **Что:** REST API для [Onsite](https://github.com/ZaycevDmitriy/field-service-crm) —
>   мобильного mini-CRM выездных сервисных работников. Превращает офлайн-приложение в
>   мультипользовательскую CRM: JWT-аутентификация с ролями, серверный реестр заявок,
>   протокол офлайн-синхронизации с идемпотентными мутациями, фотоотчёты (S3), Expo push.
> - **Стек:** TypeScript (`strict`), Node.js 24, Fastify 5 + TypeBox (schema-first),
>   PostgreSQL 16 + Drizzle ORM, MinIO/S3, Docker Compose, GitHub Actions + semantic-release.
> - **Куда смотреть:** [Синхронизация](#синхронизация) (pull по курсору с tombstone и
>   safety-lag, server-authoritative разрешение конфликтов),
>   [Аутентификация](#аутентификация) (RS256, ротация refresh с отзывом семьи),
>   [Архитектура](#архитектура) (Modular Monolith),
>   [Продакшн-деплой](#продакшн-деплой-self-host).
> - **Попробовать:** `docker compose up` — миграции и демо-сид применяются автоматически,
>   OpenAPI UI на `http://localhost:3000/docs`.

**Onsite Backend** — сервер мобильного mini-CRM Onsite (установка роутеров, диагностика линий,
ремонт кабеля). Портфолио-проект, сфокусированный на сложных частях реального field-service
бэкенда: офлайн-синхронизация, идемпотентность, разрешение конфликтов, self-host продакшн.

## Обзор

Диспетчер создаёт заявки и назначает их на техников; техник получает push-уведомление, работает
офлайн в подвалах и промзонах и синхронизируется при появлении сети. Сервер — источник истины:
каждая офлайн-мутация валидируется против текущего состояния, конфликты разрешаются на сервере,
вердикт возвращается со снимком состояния, чтобы клиент мог сойтись с сервером.

## Что демонстрирует проект

- Schema-first дизайн API: TypeBox-схемы порождают валидацию и OpenAPI-спеку; коммитимый
  снапшот `openapi.json` проверяется CI на дрейф
- Протокол офлайн-синхронизации: pull по курсору с tombstone и safety-lag, батчи идемпотентных
  мутаций, server-authoritative конфликты со снимком состояния
- Правильный JWT: RS256, короткоживущие access-токены, непрозрачные refresh-токены с ротацией
  и отзывом семьи при повторном использовании, argon2id, rate limiting логина
- Конечный автомат заявки с append-only журналом `order_events`
- Staged-загрузка фото в S3/MinIO с presigned URL и идемпотентным multipart
- Expo push через outbox-паттерн с проверкой receipt'ов и деактивацией мёртвых токенов
- Modular Monolith: модуль владеет своими таблицами и предоставляет публичный API через `index.ts`
- Наблюдаемость: структурные pino-логи с requestId, Prometheus-метрики, алёрт на долю 5xx
- Полный self-host стек: Caddy с авто-TLS, образы из GHCR, ежедневные бэкапы
- Автоматизированные релизы: Conventional Commits + semantic-release; OWASP API Top-10 аудит
  пройден перед v1.0

## Быстрый старт

Весь стек (API + PostgreSQL + MinIO, миграции и сид применяются автоматически):

```bash
npx tsx scripts/generate-jwt-keys.ts >> .env   # пара ключей RS256 (однократно)
docker compose up
```

После старта:

- `http://localhost:3000/v1/health` — статус сервиса и зависимостей;
- `http://localhost:3000/docs` — OpenAPI UI.

Учётные данные в `compose.yml` (`onsite/onsite`, `minioadmin`) — демо-стек для локального
запуска, не для продакшена.

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

### Интеграционные тесты

Требуют реальных PostgreSQL и MinIO — без `DATABASE_URL` интеграционные тесты скипаются, без
`S3_ENDPOINT` дополнительно скипаются тесты фото и мутаций синка (`photo_add`):

```bash
docker compose up -d postgres minio minio-init
DATABASE_URL=postgres://onsite:onsite@localhost:5432/onsite \
S3_ENDPOINT=http://localhost:9000 \
S3_ACCESS_KEY=minioadmin \
S3_SECRET_KEY=minioadmin \
  npm run migrate && npm test
```

Бакет тестам не нужен заранее — тесты фото создают его сами.

## Архитектура

Modular Monolith: модули `auth`, `users`, `orders`, `sync`, `photos`, `notifications`, `health`
в `src/modules/`, общая инфраструктура в `src/shared/` (db, config, errors, plugins).
Composition root — `src/app.ts` + `src/main.ts`.

Жёсткие границы:

- импорт чужого модуля только через его `index.ts`; таблицами владеет один модуль, соседи ходят
  через его публичный API;
- `shared/*` не импортирует `modules/*`;
- `domain.ts` — чистые функции без Drizzle/Fastify/AWS SDK/env; матрица переходов статусов —
  таблица-константа, зеркало guard'ов мобильного клиента;
- роуты тонкие: TypeBox-схема + вызов сервиса; роут без схемы не регистрируется;
- межмодульные отложенные действия — через таблицы-очереди (`push_outbox`), не прямые вызовы.

## Аутентификация

- `POST /v1/auth/login` — логин по email/паролю, ответ — пара `accessToken` (JWT RS256, TTL
  `ACCESS_TOKEN_TTL_SEC`, по умолчанию 15 мин) + `refreshToken` (непрозрачный, TTL
  `REFRESH_TOKEN_TTL_SEC`, по умолчанию 30 дней) + профиль `user`. 5 неудач подряд — 429 на
  15 минут.
- `POST /v1/auth/refresh` — ротация: старый токен гаснет, повторное использование погашенного
  отзывает всю семью сессий.
- `POST /v1/auth/logout` — отзыв семьи refresh-сессий.
- `POST /v1/users`, `PATCH /v1/users/:id` — управление аккаунтами (только роль `dispatcher`);
  сброс пароля отзывает все refresh-сессии пользователя; деактивация действует немедленно;
  диспетчер не может деактивировать сам себя.

Ключи RS256 задаются через env `JWT_PRIVATE_KEY`/`JWT_PUBLIC_KEY` (base64-кодированный PEM) —
генерируются скриптом `scripts/generate-jwt-keys.ts`, в git не попадают.

## Заявки

- `GET /v1/orders` — список: диспетчер видит все (фильтры `status`, `assignedTo`,
  keyset-пагинация `cursor`/`limit`), техник — только свои.
- `POST /v1/orders` — создание заявки (только `dispatcher`).
- `GET /v1/orders/:id` — заявка с committed-фото и полной историей событий; чужая заявка
  технику отвечает 404, не 403.
- `PATCH /v1/orders/:id` — правка полей (только `dispatcher`); статус меняется только через
  `transition`; заявка в `Done`/`Cancelled` → 409.
- `POST /v1/orders/:id/assign` — назначение/переназначение техника (только `dispatcher`);
  недопустимый статус заявки → 409; несуществующий, деактивированный или не-`technician`
  исполнитель → 422; повторное назначение того же техника — идемпотентно.
- `POST /v1/orders/:id/transition` — переход статуса (`dispatcher` — любая заявка,
  `technician` — только своя); недопустимый переход → 409 `invalid_transition`; несовпадение
  `baseStatus` со снимком клиента → 409 `conflict`.

Каждое изменение заявки пишется в append-only журнал `order_events` с актором и источником.

## Фото

- `POST /v1/orders/:id/photos` — multipart-загрузка (поля `file`, `takenAt`, опционально
  `comment`; заголовок `Idempotency-Key` обязателен). Повтор с тем же ключом и payload → 200 с
  той же записью; тот же ключ с другим payload → 409 `conflict`. JPEG/PNG/WebP — иначе 415;
  лимит `PHOTO_MAX_SIZE_MB` (по умолчанию 10 МБ) — иначе 413.
- `GET /v1/photos/:id/file` — 302 с `Location` на presigned URL (TTL `PHOTO_PRESIGN_TTL_SEC`,
  по умолчанию 600 с). Staged-фото — только автору; чужое/несуществующее → 404.
- Фото загружаются в статусе `staged` и не попадают в `GET /v1/orders/:id`, пока не будут
  закоммичены мутацией `photo_add` синка.
- Зачистка сирот: staged-фото старше `PHOTO_STAGED_TTL_HOURS` (по умолчанию 168 ч) удаляются
  вместе с объектом в S3 фоновым воркером (`PHOTO_CLEANUP_INTERVAL_MIN`, по умолчанию 60 мин).

## Синхронизация

Оба эндпоинта — только роль `technician`; курсор и мутации идемпотентны, конфликты разрешает
сервер (server-authoritative).

- `GET /v1/sync/orders?cursor&limit` — pull изменённых заявок техника и tombstone
  снятых/переназначенных назначений одним потоком, отсортированным по общему курсору `seq`
  (`bigint`-последовательность `sync_seq`). При неполной странице `nextCursor` сдвигается с
  safety-lag (`SYNC_SAFETY_LAG`, по умолчанию 100) — компенсирует конкурентные транзакции,
  коммитящиеся не по порядку; повторная выдача хвоста безопасна, так как pull идемпотентен.
- `POST /v1/sync/mutations` — батч офлайн-мутаций (1–500), каждая идемпотентна по клиентскому
  `mutationId` (повтор → `duplicate` с исходным вердиктом байт-в-байт) и обрабатывается в
  собственной транзакции — сбой одной не блокирует остальные.
  - `status_change` — несовпадение `baseStatus` или недопустимый переход → `conflict` со
    снимком заявки и событием `sync_conflict`; заявка не найдена → `rejected`.
  - `photo_add` — коммит ранее загруженного staged-фото; фотоотчёт по заявке в
    `Done`/`Cancelled` всё равно `applied` (ценен постфактум).

Каждая применённая мутация пишет событие в `order_events` с `source: 'sync'` и двигает курсор
заявки.

## Устройства и push-уведомления

- `PUT /v1/devices` — регистрация Expo push-токена (`{ expoPushToken }` → 204); повторная
  регистрация — upsert, в т.ч. от другого пользователя (перепривязка при re-login).
- Назначение заявки атомарно кладёт уведомление в outbox-очередь `push_outbox` — сбой Expo не
  ломает сам запрос назначения.
- Push-worker двумя стадиями: отправка (чанки, fan-out на активные устройства техника) и
  проверка receipt'ов; `DeviceNotRegistered` автоматически деактивирует токен.

## Rate limiting и метрики

- Глобальный лимит на IP + отдельный жёсткий лимит на `/v1/auth/*`; превышение — 429 тем же
  конвертом ошибок. `/v1/health` и `/metrics` из лимита исключены.
- `GET /metrics` — Prometheus-метрики (латентности по route-шаблону, коды ответов, глубина
  `push_outbox`); доступ ограничивается непубликацией порта в production-компоузе.

## Продакшн-деплой (self-host)

`compose.production.yml` — полный self-host стек: Caddy (reverse-proxy с авто-TLS через
Let's Encrypt) → api, PostgreSQL, MinIO, Prometheus (алёрт на долю 5xx), ежедневные бэкапы
`pg_dump` + бакета фото. `api`/`migrate` используют готовый образ из GHCR — сборка на VPS не
нужна. Первый диспетчер заводится через `create-first-user`. Подробности — `deploy/` (Caddyfile,
конфиг Prometheus, скрипты бэкапов) и `.env.production.example`.

## Команды

| Команда                     | Назначение                                            |
| --------------------------- | ----------------------------------------------------- |
| `npm run dev`               | Запуск с hot-reload (tsx watch)                       |
| `npm run build`             | Сборка в `dist/` (tsc + tsc-alias)                    |
| `npm run typecheck`         | Проверка типов                                        |
| `npm run lint`              | ESLint                                                |
| `npm test`                  | Тесты (vitest); интеграционные требуют `DATABASE_URL` |
| `npm run test:coverage`     | Тесты с покрытием (v8)                                |
| `npm run migrate`           | Применить миграции (только вперёд)                    |
| `npm run create-first-user` | Bootstrap: первый диспетчер при пустой `users` (прод) |
| `npm run seed`              | Идемпотентный сид демо-данных                         |
| `npm run db:generate`       | Сгенерировать миграцию из Drizzle-схем                |
| `npm run openapi:print`     | Напечатать OpenAPI-спеку в stdout                     |
| `npm run openapi:validate`  | Проверить спеку против схемы OpenAPI 3.1              |

Снапшот спеки — `openapi.json` в корне репозитория; CI проверяет, что он не разошёлся с кодом.

## Демо-учётки (сид)

| Роль      | Email                     | Пароль          |
| --------- | ------------------------- | --------------- |
| Диспетчер | `dispatcher@onsite.local` | `dispatcher123` |
| Техник    | `tech1@onsite.local`      | `technician123` |
| Техник    | `tech2@onsite.local`      | `technician123` |

Сид создаёт 6 демо-заявок, совместимых с mock-данными мобильного клиента. Все данные
вымышленные. Сид отказывается работать против продакшена (`NODE_ENV=production` или нелокальный
хост БД).

## Документация

Подробные документы — в [`docs/`](docs/):

| Документ                                                         | Описание                                                  |
| ---------------------------------------------------------------- | --------------------------------------------------------- |
| [Спецификация](docs/onsite-backend-spec.md)                      | Требования, модель данных, API-контракт (источник истины) |
| [PDR](docs/pdr.md)                                               | Цели, задачи, риски и график проекта                      |
| [Фазы реализации](docs/implementation-phases.md)                 | 6 фаз от M0 до v1.0                                       |
| [Деплой](docs/deployment.md)                                     | Продакшн-стек self-host и его решения                     |
| [Развёртывание на VPS](docs/vps-deployment-guide.md)             | Пошаговая подготовка сервера с нуля                       |
| [Тестирование API](docs/api-testing-guide.md)                    | Ручная проверка задеплоенного стека                       |
| [Аудит OWASP API Top 10](docs/security-audit-owasp-api-top10.md) | Аудит безопасности перед v1.0                             |

## Связанный репозиторий

Мобильный клиент: [field-service-crm](https://github.com/ZaycevDmitriy/field-service-crm) —
offline-first приложение на Expo / React Native (Expo Router, SQLite, EAS Build / OTA).

## Лицензия

[PolyForm Noncommercial 1.0.0](LICENSE) © 2026 Dmitriy Zaycev
