# Onsite Backend

REST API для [Onsite](https://github.com/ZaycevDmitriy/field-service-crm) — мобильного mini-CRM выездных сервисных работников. Превращает офлайн-приложение в мультипользовательскую CRM: аутентификация с ролями, серверный реестр заявок с назначением на техников, протокол офлайн-синхронизации с идемпотентными мутациями, фотоотчёты и push-уведомления.

**Стек:** Node.js 24 · Fastify 5 (TypeBox) · PostgreSQL 16 (Drizzle) · MinIO/S3 · Expo Push · Docker Compose (self-host: + Caddy, Prometheus).

**Статус:** v1.0 — синк-протокол (pull по курсору с tombstone/safety-lag, батч офлайн-мутаций с идемпотентностью), фотоотчёты (staged-загрузка, presigned URL, зачистка сирот), заявки (CRUD, назначение, конечный автомат статусов, `order_events`), аутентификация (JWT RS256, роли `dispatcher`/`technician`), push-уведомления о назначении (Expo, outbox-паттерн), rate limiting, Prometheus-метрики, self-host деплой. OWASP API Top-10 аудит пройден перед релизом.

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

### Интеграционные тесты

Требуют реальных PostgreSQL и MinIO — без `DATABASE_URL` интеграционные тесты скипаются, без `S3_ENDPOINT` дополнительно скипаются тесты фото и мутаций синка (`photo_add`):

```bash
docker compose up -d postgres minio minio-init
DATABASE_URL=postgres://onsite:onsite@localhost:5432/onsite \
S3_ENDPOINT=http://localhost:9000 \
S3_ACCESS_KEY=minioadmin \
S3_SECRET_KEY=minioadmin \
  npm run migrate && npm test
```

Бакет тестам не нужен заранее — тесты фото создают его сами.

## Аутентификация

- `POST /v1/auth/login` — логин по email/паролю, ответ — пара `accessToken` (JWT RS256, TTL `ACCESS_TOKEN_TTL_SEC`, по умолчанию 15 мин) + `refreshToken` (непрозрачный, TTL `REFRESH_TOKEN_TTL_SEC`, по умолчанию 30 дней) + профиль `user` (`id`, `email`, `role`, `displayName`, `isActive`, `createdAt`). 5 неудач подряд — 429 на 15 минут.
- `POST /v1/auth/refresh` — ротация: старый токен гаснет, повторное использование погашенного отзывает всю семью сессий.
- `POST /v1/auth/logout` — отзыв семьи refresh-сессий.
- `POST /v1/users`, `PATCH /v1/users/:id` — управление аккаунтами (только роль `dispatcher`); сброс пароля отзывает все refresh-сессии пользователя; деактивация действует немедленно; диспетчер не может деактивировать сам себя.

Ключи RS256 задаются через env `JWT_PRIVATE_KEY`/`JWT_PUBLIC_KEY` (base64-кодированный PEM) — генерируются скриптом `scripts/generate-jwt-keys.ts`, в git не попадают.

## Заявки

- `GET /v1/orders` — список: диспетчер видит все (фильтры `status`, `assignedTo`, keyset-пагинация `cursor`/`limit`), техник — только свои (`assignedTo` из query игнорируется).
- `POST /v1/orders` — создание заявки (только `dispatcher`).
- `GET /v1/orders/:id` — заявка с committed-фото и полной историей событий; чужая заявка технику отвечает 404, не 403.
- `PATCH /v1/orders/:id` — правка полей (только `dispatcher`); статус меняется только через `transition`; заявка в `Done`/`Cancelled` → 409.
- `POST /v1/orders/:id/assign` — назначение/переназначение техника (только `dispatcher`); недопустимый статус заявки → 409; несуществующий, деактивированный или не-`technician` исполнитель → 422; повторное назначение того же техника — идемпотентно.
- `POST /v1/orders/:id/transition` — переход статуса (`dispatcher` — любая заявка, `technician` — только своя); недопустимый переход → 409 `invalid_transition` с текущим статусом в теле; несовпадение `baseStatus` со снимком клиента → 409 `conflict`.

Каждое изменение заявки (создание, назначение, переход статуса) пишется в append-only журнал `order_events` с актором и источником (`api`).

## Фото

- `POST /v1/orders/:id/photos` — multipart-загрузка фотоотчёта (поля `file`, `takenAt`, опционально `comment`; заголовок `Idempotency-Key` обязателен). Первая загрузка → 201, повтор с тем же `Idempotency-Key` и тем же payload → 200 с той же записью (идемпотентность без создания второго объекта в S3); тот же ключ с другим `comment`/`takenAt` → 409 `conflict`. JPEG/PNG/WebP — иначе 415 `unsupported_media_type`; лимит размера `PHOTO_MAX_SIZE_MB` (по умолчанию 10 МБ) — иначе 413 `file_too_large`. Доступ — по правилам заявки (техник только к своей, иначе 404).
- `GET /v1/photos/:id/file` — 302 с `Location` на presigned URL (TTL `PHOTO_PRESIGN_TTL_SEC`, по умолчанию 600 с). Committed-фото — доступ по правилам заявки; staged — только автору; чужое/несуществующее → 404.
- Фото загружаются в статусе `staged` и не попадают в `GET /v1/orders/:id`, пока не будут закоммичены мутацией `photo_add` синка.
- Зачистка сирот: staged-фото старше `PHOTO_STAGED_TTL_HOURS` (по умолчанию 168 ч = 7 суток) удаляются вместе с объектом в S3 фоновым воркером (интервал `PHOTO_CLEANUP_INTERVAL_MIN`, по умолчанию 60 мин; первый прогон — при старте сервера).

## Синхронизация

Оба эндпоинта — только роль `technician`; курсор и мутации идемпотентны, конфликты разрешает сервер (server-authoritative).

- `GET /v1/sync/orders?cursor&limit` — pull изменённых заявок техника и tombstone снятых/переназначенных назначений одним потоком, отсортированным по общему курсору `seq`. Курсор — `bigint`-последовательность `sync_seq`; ответ `{ items, nextCursor }`, элемент — `{ type: 'order', order }` (заявка + committed-фото) или `{ type: 'unassigned', orderId }`. При неполной странице `nextCursor` сдвигается с safety-lag `SYNC_SAFETY_LAG` (по умолчанию 100) — компенсирует конкурентные транзакции, коммитящиеся не по порядку; повторная выдача хвоста допустима, так как pull идемпотентен.
- `POST /v1/sync/mutations` — батч офлайн-мутаций (1–500 за раз), тело `{ mutations: [...] }`, ответ `{ verdicts: [...] }`. Каждая мутация — идемпотентна по клиентскому `mutationId` (повтор → `duplicate` с исходным вердиктом байт-в-байт, состояние не меняется) и обрабатывается в собственной транзакции — сбой одной не блокирует остальные батча.
  - `status_change` — переход статуса заявки; несовпадение `baseStatus` или недопустимый переход → `conflict` со снимком заявки и событием `sync_conflict`; заявка не назначена на техника (переназначена/снята) → `conflict`; заявка не найдена → `rejected`.
  - `photo_add` — коммит ранее загруженного staged-фото (`photoId`); неизвестный/чужой/уже закоммиченный `photoId`, либо `orderId` мутации не совпадает с заявкой фото → `rejected`; заявка в статусе `Cancelled`/`Done` — фотоотчёт всё равно `applied` (ценен постфактум).
  - Каждая применённая мутация пишет событие в `order_events` с `source: 'sync'` и двигает курсор заявки.

## Устройства и push-уведомления

- `PUT /v1/devices` — регистрация Expo push-токена устройства (`{ expoPushToken }` → 204); повторная регистрация того же токена — upsert, в т.ч. от другого пользователя (легитимная перепривязка при re-login на новом аккаунте).
- Назначение заявки (`POST /v1/orders/:id/assign`) атомарно кладёт push-уведомление в outbox-очередь `push_outbox` — сбой отправки в Expo не ломает сам запрос назначения.
- Push-worker (в процессе api, интервал `PUSH_WORKER_INTERVAL_SEC`) двумя стадиями: отправка (чанки в Expo, fan-out на все активные устройства техника) и проверка receipt'ов (`PUSH_RECEIPT_DELAY_MIN`) — `DeviceNotRegistered` на любой стадии автоматически деактивирует токен.

## Rate limiting и метрики

- Глобальный лимит запросов на IP + отдельный жёсткий лимит на `/v1/auth/*` (`@fastify/rate-limit`); превышение — 429 тем же конвертом ошибок `{ code: 'too_many_attempts', message }`. `/v1/health` и `/metrics` из лимита исключены.
- `GET /metrics` — Prometheus-метрики (латентности по route-шаблону, коды ответов, глубина `push_outbox`); без аутентификации — доступ ограничивается непубликацией порта наружу в production-компоузе, не приложением.

## Продакшн-деплой (self-host)

`compose.production.yml` — полный self-host стек: Caddy (reverse-proxy с авто-TLS через Let's Encrypt) → api, PostgreSQL, MinIO, Prometheus (алёрт-правило на долю 5xx-ответов), ежедневные бэкапы `pg_dump` + бакета фото. `api`/`migrate` используют готовый образ из GHCR — сборка на VPS не нужна. Демо-сид (`npm run seed`) в проде не запускается; первый диспетчер заводится через `create-first-user`. Подробности — в `docs/deployment.md`, `deploy/` (Caddyfile, конфиг Prometheus, скрипты бэкапов) и `.env.production.example`.

> Примечание к обновлению до этой версии: верификация JWT теперь требует клеймы `iss`/`aud` — access-токены, выпущенные предыдущими версиями, разово получат 401; клиент штатно обновит их через refresh.

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

Снапшот спеки — `openapi.json` в корне репозитория; CI проверяет, что он не разошёлся с кодом. После изменения схем: `npm run openapi:print --silent > openapi.json`.

## Демо-учётки (сид)

| Роль      | Email                     | Пароль          |
| --------- | ------------------------- | --------------- |
| Диспетчер | `dispatcher@onsite.local` | `dispatcher123` |
| Техник    | `tech1@onsite.local`      | `technician123` |
| Техник    | `tech2@onsite.local`      | `technician123` |

Сид создаёт 6 демо-заявок, совместимых с mock-данными мобильного клиента. Все данные вымышленные.

## Лицензия

PolyForm Noncommercial 1.0.0 — см. [LICENSE](LICENSE).
