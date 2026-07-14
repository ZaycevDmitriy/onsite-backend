[← Фазы реализации](implementation-phases.md) · [К README](../README.ru.md) · [Развёртывание на VPS →](vps-deployment-guide.md)

# Деплой self-host (T-19, фаза 6; упрощение — v1.1)

Продакшн-стек одного VPS: Caddy (авто-TLS) → api, PostgreSQL, MinIO (фото), Prometheus (метрики),
ежедневные бэкапы pg_dump + MinIO. Файлы — `compose.production.yml`, `deploy/`.

`api`/`migrate` используют готовый образ из GHCR (`release.yml` публикует его после каждого
релиза `main`) — сборка на VPS не требуется, на сервере достаточно `compose.production.yml`,
`deploy/` и `.env.production`, git-клон не нужен. **Минимальная версия образа с этой схемой
деплоя — та, что содержит `dist/cli/migrate.js` и `dist/cli/create-first-user.js`** (первый
релиз после слияния изменения «упрощение прод-деплоя», v1.1); более старые теги собирались
только из `scripts/` и с этим `compose.production.yml` не запустятся.

## Предпосылки

- VPS с Docker + Docker Compose v2, порты 80/443 открыты наружу.
- Два DNS A-записи, указывающие на IP сервера: домен API (`DOMAIN_API`) и домен хранилища
  фото (`DOMAIN_STORAGE`) — Caddy выпускает TLS-сертификаты Let's Encrypt на оба автоматически
  при первом запуске, DNS должен резолвиться ДО старта.
- Рабочая пара RS256-ключей: `npx tsx scripts/generate-jwt-keys.ts` (base64 PEM в вывод).
- Если пакет `ghcr.io/zaycevdmitriy/onsite-backend` приватный — `docker login ghcr.io` на сервере
  с личным токеном (scope `read:packages`) до первого `pull`; для публичного пакета логин не нужен.

## Настройка

```bash
cp .env.production.example .env.production
# Заполнить: домены, ACME_EMAIL, POSTGRES_*, MINIO_ROOT_*, JWT_*_KEY, при необходимости APP_VERSION.
# POSTGRES_PASSWORD/MINIO_ROOT_PASSWORD — сгенерировать, не использовать дефолты из dev compose.yml.
```

`APP_VERSION` (по умолчанию `latest`) — тег образа `api`/`migrate` в GHCR; пин конкретной версии
(например `1.7.0`) даёт воспроизводимые деплои, список версий — вкладка Releases репозитория.

`.env.production` не коммитить (см. `.gitignore`).

## Запуск

```bash
docker compose -f compose.production.yml --env-file .env.production pull
docker compose -f compose.production.yml --env-file .env.production up -d
docker compose -f compose.production.yml --env-file .env.production logs -f api
```

`migrate` — one-shot, применяет только миграции (`node dist/cli/migrate.js`). **Seed НЕ
запускается** в проде намеренно: `scripts/seed-data.ts` создаёт демо-аккаунты с публично
известными паролями (`dispatcher123`/`technician123`, задокументированы в README) — приемлемо
для dev-стенда, неприемлемо для продакшна (находка аудита
`docs/security-audit-owasp-api-top10.md`, §API2). Первый рабочий аккаунт создать через
`create-first-user` (см. «Первый запуск» ниже).

Проверка: `curl https://<DOMAIN_API>/v1/health` → `{"status":"ok","deps":{"db":"ok"}}`. Сервис
`api` также сам публикует `healthcheck` в Docker (fetch на `/v1/health`) — `docker compose ps`
показывает `healthy`/`unhealthy`, а Caddy стартует только после того, как api станет здоровым.

## Обновление

```bash
docker compose -f compose.production.yml --env-file .env.production pull
docker compose -f compose.production.yml --env-file .env.production up -d
```

`migrate` — one-shot с `depends_on: postgres` и `condition: service_completed_successfully` у
`api`: миграции применяются автоматически при каждом `up -d`, до старта api.

## Первый запуск: создание первого диспетчера

Самостоятельной регистрации нет (аккаунты создаёт диспетчер, см. спеку §5.6) — первый аккаунт
создаётся bootstrap-скриптом `create-first-user`, который заводит диспетчера только при пустой
таблице `users` (повторный запуск на непустой таблице — отказ, без побочных эффектов):

```bash
docker compose -f compose.production.yml --env-file .env.production run --rm \
  -e FIRST_USER_EMAIL="dispatcher@example.com" \
  -e FIRST_USER_PASSWORD="<сгенерировать>" \
  -e FIRST_USER_NAME="Диспетчер" \
  api node dist/cli/create-first-user.js
```

Пароль — минимум 12 символов (та же валидация, что у `POST /v1/users`); при невалидном вводе
скрипт откажет, причина — в логе контейнера. Пароль передаётся через переменную окружения
одноразового контейнера: команда с ведущим пробелом не попадает в историю шелла bash/zsh
(`HIST_IGNORE_SPACE`/`setopt HIST_IGNORE_SPACE`) — либо задать пароль через
`read -s FIRST_USER_PASSWORD` перед вызовом и не печатать его в терминал.
Остальные пользователи создаются штатно через `POST /v1/users` под этим диспетчером.

## TLS и домены

Caddy (`deploy/caddy/Caddyfile`) держит два сайта:

- `DOMAIN_API` → `api:3000` — весь трафик приложения. Путь `/metrics` блокируется на уровне Caddy
  (`respond 404`) — метрики без auth (решение фазы 6), доступны только по внутренней docker-сети.
- `DOMAIN_STORAGE` → `minio:9000` — presigned URL фотоотчётов ведут сюда напрямую, без прокси
  через api (иначе бинарники шли бы двойным хопом).

Сертификаты и состояние ACME — в volume `caddy-data`, переживают `docker compose down` (без `-v`).

## Мониторинг

Prometheus (`deploy/prometheus/prometheus.yml`) скрейпит `api:3000/metrics` каждые 30 с, правило
алёрта 5xx > 1%/5мин — `deploy/prometheus/alert-rules.yml`. Порт Prometheus не публикуется
наружу (решение фазы 6) — просмотр UI через SSH-туннель:

```bash
ssh -L 9090:localhost:9090 user@server
# затем открыть http://localhost:9090 локально
```

Alertmanager (доставка алёртов в канал/почту) — вне объёма фазы 6: правило зафиксировано,
нотификации — кандидат следующей итерации. Пока алёрт можно смотреть вручную на вкладке Alerts
в Prometheus UI.

## Логи

Все сервисы стека ограничены драйвером `json-file` с ротацией (`max-size: 10m`, `max-file: 3`,
якорь `x-logging` в `compose.production.yml`) — на долгоживущем VPS диск не заполняется логами
приложения (pino пишет структурный JSON в stdout непрерывно). Просмотр — `docker compose logs`,
как в разделе «Запуск».

## Бэкапы (NFR-03: RPO ≤ 24 ч, RTO ≤ 4 ч)

`backup-postgres` (`deploy/backup/backup-postgres.sh`) и `backup-minio`
(`deploy/backup/backup-minio.sh`) — раз в сутки, первый прогон сразу при старте стека. Снапшоты — в
volume `backups`, ретеншн `BACKUP_RETENTION_DAYS` (по умолчанию 14 дней).

**Офсайт-копия — вручную**, не автоматизирована (вне объёма фазы 6): периодически синхронизировать
volume `backups` на другой сервер/объектное хранилище, например:

```bash
docker run --rm -v onsite-backend_backups:/backups -v "$(pwd)/offsite:/offsite" alpine \
  cp -r /backups/. /offsite/
# rsync/rclone /offsite куда-либо вне сервера.
```

### Восстановление (RTO)

```bash
# Postgres:
gunzip -c onsite-<timestamp>.sql.gz | \
  docker compose -f compose.production.yml exec -T postgres \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"

# MinIO: скопировать снапшот-директорию обратно через mc mirror в обратную сторону
# (mc alias уже настроен внутри backup-minio — использовать тот же контейнер вручную).
```

## Безопасность

Итоги аудита — `docs/security-audit-owasp-api-top10.md`. Ключевое для деплоя:

- `trustProxy: true` в приложении — `request.ip` берётся из `X-Forwarded-For` от Caddy;
  без прямого доступа к api в обход Caddy эта настройка безопасна (единственный proxy-хоп).
- `postgres`/`minio`/`prometheus`/`api` — только `expose` (внутренняя docker-сеть), не `ports`:
  единственная публично достижимая точка входа — `caddy` (80/443).
- Секреты — только через `.env.production` (не коммитится); в `compose.production.yml` дефолтов
  вида `onsite`/`minioadmin` нет намеренно — старт без заполненного `.env.production` падает.

## Смежные страницы

- [Развёртывание на VPS](vps-deployment-guide.md) — пошаговая подготовка сервера с нуля.
- [Тестирование API на VPS](api-testing-guide.md) — ручная проверка задеплоенного стека.
- [Аудит OWASP API Top 10](security-audit-owasp-api-top10.md) — контекст решений по безопасности.
