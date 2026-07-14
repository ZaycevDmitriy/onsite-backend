[← Деплой](deployment.md) · [К README](../README.ru.md) · [Тестирование API →](api-testing-guide.md)

# Развёртывание Onsite Backend на VPS — пошаговая инструкция

Проект готов к деплою: в репозитории есть полный self-host-стек — `compose.production.yml`
(Caddy с авто-TLS → api, PostgreSQL 16, MinIO, Prometheus, ежедневные бэкапы),
`.env.production.example` и базовая документация в `docs/deployment.md`.
Эта инструкция дополняет её шагами подготовки самого сервера.

## Требования к VPS

- 2 vCPU / 2–4 ГБ RAM / 20+ ГБ диска (Postgres + MinIO-фото растут со временем), Ubuntu 22.04/24.04 или аналог.
- Публичный IP, открытые наружу порты **80 и 443** (только они — остальные сервисы живут во внутренней docker-сети).
- Два поддомена с A-записями на IP сервера: для API (например `api.вашдомен.ru`) и для хранилища фото
  (`storage.вашдомен.ru`). **DNS должен резолвиться до первого запуска** — Caddy при старте сам выпускает
  сертификаты Let's Encrypt на оба домена.

## 1. Подготовка сервера

```bash
ssh root@<IP>

# Обновление и базовая гигиена
apt update && apt upgrade -y

# Отдельный пользователь вместо root
adduser deploy
usermod -aG sudo deploy

# Docker + Compose v2 (официальный скрипт)
curl -fsSL https://get.docker.com | sh
usermod -aG docker deploy

# Firewall: только SSH, HTTP, HTTPS
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
```

Рекомендуется отключить вход по паролю в SSH (`PasswordAuthentication no` в `/etc/ssh/sshd_config`),
оставив только ключи.

## 2. Файлы деплоя на сервере

Сборка на VPS не нужна: `api`/`migrate` используют готовый образ из GHCR
(`release.yml` публикует его после каждого релиза `main`). На сервере достаточно трёх вещей —
`compose.production.yml`, каталог `deploy/` и `.env.production` (Node.js и git-клон не нужны):

```bash
su - deploy
mkdir onsite-backend && cd onsite-backend
scp <локальная-машина>:onsite-backend/compose.production.yml .
scp -r <локальная-машина>:onsite-backend/deploy .
```

Если пакет `ghcr.io/zaycevdmitriy/onsite-backend` приватный — `docker login ghcr.io` на сервере
с личным токеном (scope `read:packages`) до первого `pull`.

## 3. Секреты и конфигурация

Ключи JWT удобнее сгенерировать локально (на машине, где есть Node):

```bash
npx tsx scripts/generate-jwt-keys.ts
# Выведет JWT_PRIVATE_KEY и JWT_PUBLIC_KEY (base64 PEM)
```

На сервере:

```bash
cp .env.production.example .env.production
nano .env.production
```

Заполнить:

| Переменная | Что вписать |
|---|---|
| `DOMAIN_API`, `DOMAIN_STORAGE` | ваши поддомены |
| `ACME_EMAIL` | почта для Let's Encrypt |
| `POSTGRES_USER`, `POSTGRES_PASSWORD` | свои значения, пароль сгенерировать (`openssl rand -base64 24`) |
| `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD` | то же самое, не `minioadmin` |
| `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY` | из скрипта выше |
| `EXPO_ACCESS_TOKEN` | опционально, для push-уведомлений |
| `APP_VERSION` | опционально: тег образа GHCR, по умолчанию `latest` |

Compose-файл намеренно без дефолтных секретов — при пустом `.env.production` стек не стартует.
Файл в `.gitignore`, коммитить его нельзя.

## 4. Запуск

```bash
docker compose -f compose.production.yml --env-file .env.production pull
docker compose -f compose.production.yml --env-file .env.production up -d
docker compose -f compose.production.yml --env-file .env.production logs -f api
```

Что произойдёт автоматически:

- `migrate` (one-shot) применит миграции drizzle;
- `minio-init` создаст бакет `onsite-photos`;
- Caddy выпустит TLS-сертификаты на оба домена;
- запустятся `backup-postgres` и `backup-minio` (первый снапшот — сразу, далее раз в сутки,
  ретеншн 14 дней, переменная `BACKUP_RETENTION_DAYS`).

Проверка:

```bash
curl https://api.вашдомен.ru/v1/health
# → {"status":"ok","deps":{"db":"ok"}}
```

Сервис `api` также сам публикует Docker `healthcheck` (fetch на `/v1/health`) — `docker compose ps`
показывает `healthy`/`unhealthy`, Caddy стартует только после того, как api станет здоровым.

## 5. Первый аккаунт диспетчера

Самостоятельной регистрации в API нет (аккаунты создаёт диспетчер), а seed в проде **намеренно
не запускается** — он создаёт демо-аккаунты с публично известными паролями. Первый диспетчер
заводится bootstrap-скриптом `create-first-user`, который отказывает при уже непустой таблице
`users` (безопасно перезапускать):

```bash
docker compose -f compose.production.yml --env-file .env.production run --rm \
  -e FIRST_USER_EMAIL="dispatcher@example.com" \
  -e FIRST_USER_PASSWORD="<сгенерировать>" \
  -e FIRST_USER_NAME="Диспетчер" \
  api node dist/cli/create-first-user.js
```

Пароль — минимум 12 символов (та же валидация, что у `POST /v1/users`); при невалидном вводе
скрипт откажет с причиной в логе контейнера. Пароль через переменную окружения одноразового
контейнера безопаснее ручного SQL: команду с ведущим пробелом bash/zsh не пишет в историю
(или явно `read -s FIRST_USER_PASSWORD` перед вызовом). Детали — в `docs/deployment.md`
(раздел «Первый запуск»). После этого остальные
пользователи создаются штатно через `POST /v1/users`.

## 6. Эксплуатация

- **Мониторинг:** Prometheus скрейпит `api:3000/metrics` каждые 30 с, наружу не опубликован.
  Смотреть через SSH-туннель: `ssh -L 9090:localhost:9090 deploy@сервер` → `http://localhost:9090`.
  Настроено правило алёрта «5xx > 1% за 5 мин» (вкладка Alerts).
- **Логи:** `docker compose -f compose.production.yml --env-file .env.production logs -f api` —
  структурный JSON (pino); все сервисы ограничены ротацией `json-file` (`max-size: 10m`,
  `max-file: 3`) — диск VPS не заполняется логами.
- **Обновление версии:**

  ```bash
  docker compose -f compose.production.yml --env-file .env.production pull
  docker compose -f compose.production.yml --env-file .env.production up -d
  ```

  Миграции применятся автоматически (one-shot `migrate` перед стартом api). Для пина конкретного
  релиза вместо `latest` — задать `APP_VERSION` в `.env.production` перед `pull`.
- **Бэкапы:** снапшоты лежат в volume `backups`. Восстановление Postgres:

  ```bash
  gunzip -c onsite-<timestamp>.sql.gz | \
    docker compose -f compose.production.yml exec -T postgres \
    psql -U <POSTGRES_USER> -d onsite
  ```

## Оценка готовности

Готово и проверено аудитом (OWASP API Top 10, `docs/security-audit-owasp-api-top10.md`):
единственная публичная точка входа — Caddy; `/metrics` заблокирован снаружи; секреты только из env;
rate limiting; JWT RS256 с ротацией refresh-токенов; `trustProxy` под один прокси-хоп.

Упрощение деплоя (v1.1) закрыло все четыре ручных пункта из предыдущей версии этой инструкции:
деплой из готового GHCR-образа без сборки на VPS, bootstrap-скрипт `create-first-user` вместо
ручного SQL, Docker `healthcheck` для `api` (Caddy ждёт готовности), ротация docker-логов.

Что по-прежнему делается руками (осознанно вне текущего объёма):

1. **Офсайт-копия бэкапов** — снапшоты лежат на том же сервере; при потере VPS они пропадут вместе
   с ним. Периодически выгружать volume `backups` наружу (rsync/rclone), пример команды —
   в `docs/deployment.md` (раздел «Бэкапы»). Самый важный оставшийся ручной пункт.
2. **Alertmanager** — правило алёрта есть, но доставка уведомлений (почта/мессенджер) не настроена;
   алёрты видны только в UI Prometheus.

Итого: для базового запуска ничего дописывать не требуется — весь путь сводится к DNS,
`.env.production` и `docker compose pull && up -d`.

## Смежные страницы

- [Деплой](deployment.md) — описание продакшн-стека и его решений.
- [Тестирование API на VPS](api-testing-guide.md) — проверка задеплоенного стека curl'ом.
- [Аудит OWASP API Top 10](security-audit-owasp-api-top10.md) — итоги проверки безопасности.
