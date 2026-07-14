[← Тестирование API](api-testing-guide.md) · [К README](../README.ru.md)

# OWASP API Security Top 10 (2023) — аудит перед v1.0

**Дата:** 2026-07-07. **Область:** весь REST API (`src/modules/*`, `src/shared/*`, `src/app.ts`).
**Метод:** ручной построчный обзор роутов/схем/сервисов/конфигурации + `npm audit` по продакшн-зависимостям.
Часть T-19 фазы 6 (NFR-03, NFR-06).

## Итог

| Категория | Статус | Находки |
|---|---|---|
| API1: Broken Object Level Authorization | ✅ Проверено, нарушений нет | — |
| API2: Broken Authentication | ⚠️ Находка (инфраструктурная) | Демо-сид со слабыми паролями — фикс в T-19 (деплой) |
| API3: Broken Object Property Level Authorization | ✅ Проверено, нарушений нет | — |
| API4: Unrestricted Resource Consumption | 🔧 Исправлено | `maxLength` на непроверенных строках |
| API5: Broken Function Level Authorization | ✅ Проверено, нарушений нет | — |
| API6: Unrestricted Access to Sensitive Business Flows | ✅ Проверено, нарушений нет | Покрыто rate limiting (T-17) |
| API7: Server Side Request Forgery | ✅ Не применимо | Нет исходящих запросов по URL от клиента |
| API8: Security Misconfiguration | 🔧 Исправлено | `trustProxy` за reverse-proxy |
| API9: Improper Inventory Management | ✅ Проверено, принятый риск | Swagger UI публичен — осознанно (портфолио) |
| API10: Unsafe Consumption of APIs | ✅ Проверено, нарушений нет | — |

## API1: Broken Object Level Authorization

Проверены все `:id`-эндпоинты на предмет доступа к чужим объектам:

- `GET/POST /v1/orders/:id*` — techician видит/меняет статус только своей заявки (`assignedTo !== requester.id` → 404, не 403); dispatcher — любую (по замыслу, единственная организация).
- `POST /v1/orders/:id/photos`, `GET /v1/photos/:id/file` — доступ к заявке проверяется тем же правилом; staged-фото — только автору.
- `POST /v1/sync/mutations` (`status_change`) — `applySyncTransition` отклоняет чужую заявку вердиктом `conflict`, не молча применяет.
- `POST /v1/sync/mutations` (`photo_add`) — `photo.authorId !== requester.id || photo.orderId !== mutation.orderId` → `rejected`.
- `PUT /v1/devices` — всегда оперирует `requester.id` из токена, id устройства с клиента не принимается.
- Идемпотентность sync-мутаций скоупится по `userId` (исправлено ещё до начала фазы 6).

Везде, где заявка/фото не принадлежит технику — 404, не 403 (правило проекта, скрывает существование чужих ресурсов). Нарушений не найдено.

## API2: Broken Authentication

Проверено: JWT RS256 (алгоритм зафиксирован, не принимается с клиента), access 15 мин / refresh 30 дней с ротацией, отзыв всей цепочки при replay, argon2id с параметрами `m=19456,t=2,p=1` (соответствует рекомендации OWASP Password Storage Cheat Sheet), lockout 5 неудач/15 мин с timing-safe ответом для несуществующих email, пароли ≥ 12 символов (NIST 800-63B). Самостоятельной регистрации нет — аккаунты создаёт диспетчер.

**Находка (инфраструктурная, не код):** `scripts/seed-data.ts` создаёт 3 демо-аккаунта с публично известными паролями (`dispatcher123`, `technician123` — они в открытом репозитории). `compose.yml` (dev) запускает `seed.ts` автоматически при `docker compose up`. Если этот же workflow по неосторожности повторить в проде — там появятся аккаунты с известными паролями.
**План фикса:** `compose.production.yml` (T-19, деплой) не должен запускать seed вообще; `docs/deployment.md` явно предупреждает не сидить прод. Демо-данные — намеренная фича для ревьюеров портфолио (README документирует их), не баг сама по себе; риск — только в неверном окружении.

## API3: Broken Object Property Level Authorization

Проверены тела запросов на предмет mass assignment: `createUserBodySchema`/`updateUserBodySchema` не позволяют технику или через update-эндпоинт сменить `role` (поле есть только в create, сам create — `dispatcherOnly`). Ни один сервис не делает `db.insert(...).values(request.body)` напрямую — везде явный маппинг нужных полей (`title: input.title, client: input.client, ...`), поэтому даже лишние поля в теле (AJV по умолчанию не режет `additionalProperties`) не долетают до БД. `userViewSchema` не содержит `passwordHash`. Нарушений не найдено.

## API4: Unrestricted Resource Consumption

Проверено: лимит размера фото (`PHOTO_MAX_SIZE_MB` + `bodyLimit` на роуте), лимит батча sync-мутаций (`maxItems: 500`), пагинация списков (`limit ≤ 200/500`), rate limiting на IP (T-17).

**Находка → исправлено:** несколько строковых полей, полностью подконтрольных атакующему, были без `maxLength`:
- `refreshBodySchema.refreshToken` (`src/modules/auth/schemas.ts`) — эндпоинт **не аутентифицирован**, ограничение отсутствовало полностью. Добавлен `maxLength: 512` (реальный токен — ~43 символа в base64url).
- `mutationId`/`orderId`/`photoId` в `src/modules/sync/schemas.ts` — до 500 мутаций в одном батче, каждая с неограниченными строками. Добавлен общий `idFieldSchema` с `maxLength: 128`.

`format: 'uuid'` на этих полях сознательно не ставился раньше (решение #8 фазы 5) — чтобы невалидный id давал вердикт `rejected` по конкретной мутации, а не 422 на весь батч; `maxLength` этому не противоречит.

## API5: Broken Function Level Authorization

Инвентаризация ролевых guard'ов по всем 18 эндпоинтам (17 в `routes.ts` + `/metrics`):

| Роут | Guard |
|---|---|
| `POST /v1/users`, `PATCH /v1/users/:id` | `dispatcherOnly` |
| `POST /v1/orders`, `PATCH /v1/orders/:id`, `POST /v1/orders/:id/assign` | `dispatcherOnly` |
| `GET /v1/orders`, `GET /v1/orders/:id`, `POST /v1/orders/:id/transition` | `authenticate` (обе роли, скоуп — в сервисе) |
| `POST /v1/orders/:id/photos`, `GET /v1/photos/:id/file` | `authenticate` |
| `GET /v1/sync/orders`, `POST /v1/sync/mutations` | `technicianOnly` |
| `PUT /v1/devices` | `authenticate` |
| `POST /v1/auth/*` | без auth (по контракту) + жёсткий rate limit |
| `GET /v1/health` | без auth (по контракту), без rate limit |
| `GET /metrics` | без auth (решение #5 фазы 6 — сеть, не приложение), без rate limit |

Расхождений с §5.6 спецификации не найдено.

## API6: Unrestricted Access to Sensitive Business Flows

Чувствительные бизнес-флоу (назначение заявки, переходы статуса, логин) не имели защиты от автоматизированного злоупотребления до T-17 (rate limiting). После T-17 — глобальный лимит на IP + жёсткий лимит на `/v1/auth/*`. Доп. меры (капча и т.п.) избыточны для текущего NFR-тира (portfolio/self-host, solo-разработчик) — не добавлялись.

## API7: Server Side Request Forgery

Исходящих HTTP-запросов, URL которых строится из пользовательского ввода, в кодовой базе нет: S3/MinIO-клиент ходит по эндпоинту из конфига (не из запроса), Expo Push — по фиксированному API Expo. Presigned URL для фото подписывается SDK, не проксируется бэкендом. Не применимо.

## API8: Security Misconfiguration

Проверено: helmet подключён, stack trace не уходит в ответ (`error-handler.ts` — 500 без деталей, полный `err` только в лог), логи не пишут тела запросов и `authorization`/`cookie` редактируются (NFR-07), CORS не подключён (мобильный клиент, не браузер — намеренно), non-root пользователь в Docker-образе, dev-зависимости не попадают в runtime-стадию, секретов в git-истории не найдено (`git grep` по паттернам приватных ключей/AKIA/xox-токенов — пусто), `npm audit --omit=dev` — 0 уязвимостей.

**Находка → исправлено:** у Fastify не был выставлен `trustProxy`. В планируемом деплое (T-19, Caddy как reverse-proxy) `request.ip` без этой опции всегда равен адресу самого Caddy — rate limiting по IP (T-17) схлопывается в одну общую корзину на всех клиентов сразу (один агрессивный клиент блокирует всех). Добавлено `trustProxy: true` в `src/app.ts`; поведение закреплено тестом (`src/__tests__/app.test.ts`, читает `request.ip` через `X-Forwarded-For`).

## API9: Improper Inventory Management

Инвентарь эндпоинтов (таблица в API5) сверен с §5.6 спецификации — расхождений нет, теневых/забытых роутов не найдено. `/metrics` намеренно скрыт из OpenAPI (`schema: { hide: true }`), чтобы не попадать в публичный контракт `/docs`.

**Принятый риск (не фикс):** Swagger UI (`/docs`) публично доступен без аутентификации в любом окружении, включая прод — раскрывает полную схему API. Для портфолио-проекта это осознанная витрина (README ссылается на `/docs` как на фичу). Для гипотетического закрытого прод-контура — рекомендация на будущее: basic-auth на `/docs` через reverse-proxy; не внедрялось, так как не входит в объём PDR фазы 6 и не запрашивалось.

## API10: Unsafe Consumption of APIs

Внешние API: Expo Push (`expo-server-sdk`), S3/MinIO. Ответы Expo (тикеты/receipt'ы) используются только для внутренней логики воркера (статус outbox, деактивация устройства) — наружу в API-ответы не пробрасываются. Storage key для S3 строится детерминированно из `sha256(authorId:idempotencyKey)`, путь не собирается конкатенацией с сырым пользовательским вводом — path traversal исключён. MIME-тип фото проверяется дважды: заявленный `Content-Type` + магические байты содержимого (`matchesDeclaredMimeType`) — не доверяет одному только заголовку от клиента. Нарушений не найдено.

## Изменённые файлы (фиксы этого аудита)

- `src/modules/auth/schemas.ts` — `maxLength` на `refreshToken`.
- `src/modules/sync/schemas.ts` — `maxLength` на `mutationId`/`orderId`/`photoId`.
- `src/app.ts` — `trustProxy: true`.
- `src/__tests__/app.test.ts` — регрессионный тест на `trustProxy`.

## Смежные страницы

- [Спецификация](onsite-backend-spec.md) — NFR-05/NFR-06, которые проверял аудит.
- [Деплой](deployment.md) — инфраструктурные фиксы аудита (seed, `/metrics`, секреты).
- [Тестирование API на VPS](api-testing-guide.md) — ручной чек-лист безопасности на живом стеке.
