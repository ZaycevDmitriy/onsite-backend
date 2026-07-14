[← Развёртывание на VPS](vps-deployment-guide.md) · [К README](../README.ru.md) · [Аудит безопасности →](security-audit-owasp-api-top10.md)

# Тестирование эндпоинтов Onsite Backend на VPS — инструкция

Инструкция для ручной проверки задеплоенного стека (`compose.production.yml`) с локальной машины.
Все запросы идут через Caddy по HTTPS на `https://api.<домен>` — далее в примерах `$API`.

## Что нужно

1. **`curl` и `jq`** на локальной машине (`brew install jq`).
2. **Домен API** — тот, что в `DOMAIN_API` в `.env.production`.
3. **Первый диспетчер** — создан bootstrap-скриптом `create-first-user` (см. `docs/vps-deployment-guide.md`, раздел 5). Без него залогиниться не во что: самостоятельной регистрации в API нет.
4. Опционально: полный контракт API — снапшот `openapi.json` в корне репозитория (CI гарантирует его актуальность), его можно импортировать в Postman/Insomnia/Bruno и тестировать оттуда вместо curl.

Подготовка переменных в терминале:

```bash
export API="https://api.вашдомен.ru"
```

## 0. Health и инфраструктура

```bash
curl -s "$API/v1/health" | jq
# Ожидание: {"status":"ok","deps":{"db":"ok"}}
```

Дополнительно на сервере:

```bash
docker compose -f compose.production.yml --env-file .env.production ps
# api должен быть healthy, migrate — exited (0)
```

Проверка, что внутренние сервисы НЕ торчат наружу (должны падать по таймауту/отказу соединения):

```bash
curl -s --max-time 5 "http://<IP-сервера>:5432" ; echo "postgres: $?"
curl -s --max-time 5 "http://<IP-сервера>:9000" ; echo "minio: $?"
curl -s "$API/metrics" -o /dev/null -w '%{http_code}\n'   # НЕ 200: /metrics закрыт снаружи
```

## 1. Аутентификация

### Логин диспетчера

```bash
LOGIN=$(curl -s "$API/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"dispatcher@example.com","password":"<пароль>"}')
echo "$LOGIN" | jq

export AT=$(echo "$LOGIN" | jq -r .accessToken)
export RT=$(echo "$LOGIN" | jq -r .refreshToken)
```

Ожидание: 200, пара `accessToken` (JWT) + `refreshToken` (opaque) + объект `user` (`id`, `email`, `role`, `displayName`, `isActive`, `createdAt`). Негативный кейс: неверный пароль → 401 с конвертом `{ "code": "...", "message": "..." }`.

### Refresh (ротация)

```bash
curl -s "$API/v1/auth/refresh" \
  -H 'Content-Type: application/json' \
  -d "{\"refreshToken\":\"$RT\"}" | jq
```

Ожидание: новая пара токенов. **Повторный** refresh с тем же (уже использованным) токеном → 401 и отзыв всей семьи сессий — это проверка защиты от reuse. После этого теста перелогиньтесь.

### Logout

```bash
curl -s "$API/v1/auth/logout" \
  -H 'Content-Type: application/json' \
  -d "{\"refreshToken\":\"$RT\"}" -o /dev/null -w '%{http_code}\n'
```

### Rate limiting auth

Auth-роуты имеют отдельный, более жёсткий лимит. Проверка: ~15 подряд неверных логинов —
в какой-то момент придёт 429.

```bash
for i in $(seq 1 15); do
  curl -s -o /dev/null -w '%{http_code} ' "$API/v1/auth/login" \
    -H 'Content-Type: application/json' \
    -d '{"email":"dispatcher@example.com","password":"wrong-password-123"}'
done; echo
```

## 2. Пользователи (только dispatcher)

### Создать техника

```bash
TECH=$(curl -s "$API/v1/users" \
  -H "Authorization: Bearer $AT" \
  -H 'Content-Type: application/json' \
  -d '{
    "email": "tech1@example.com",
    "password": "минимум-12-символов",
    "role": "technician",
    "displayName": "Техник Первый"
  }')
echo "$TECH" | jq
export TECH_ID=$(echo "$TECH" | jq -r .id)
```

Ожидание: 201, объект без `passwordHash`. Негативные кейсы:

- пароль короче 12 символов → 422;
- дубль email → 409;
- запрос **токеном техника** → 403;
- без токена → 401.

### Изменить пользователя

```bash
curl -s -X PATCH "$API/v1/users/$TECH_ID" \
  -H "Authorization: Bearer $AT" \
  -H 'Content-Type: application/json' \
  -d '{"displayName":"Техник Переименованный"}' | jq
```

Пустое тело `{}` → 422 (`minProperties: 1`). `{"isActive": false}` деактивирует пользователя и отзывает его сессии — после этого его логин должен вернуть 401.

Залогиньте техника — его токены понадобятся дальше:

```bash
TLOGIN=$(curl -s "$API/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"tech1@example.com","password":"минимум-12-символов"}')
export TAT=$(echo "$TLOGIN" | jq -r .accessToken)
```

## 3. Заявки

### Создать (dispatcher)

```bash
ORDER=$(curl -s "$API/v1/orders" \
  -H "Authorization: Bearer $AT" \
  -H 'Content-Type: application/json' \
  -d '{
    "title": "Замена счётчика",
    "client": "Иванов И.И.",
    "address": "ул. Ленина, 1",
    "description": "Заменить счётчик холодной воды",
    "scheduledAt": "2026-07-15T09:00:00Z",
    "slotStart": "2026-07-15T09:00:00Z",
    "slotEnd": "2026-07-15T11:00:00Z",
    "latitude": 55.75,
    "longitude": 37.62
  }')
echo "$ORDER" | jq
export ORDER_ID=$(echo "$ORDER" | jq -r .id)
```

Ожидание: 201, `status: "new"`, `assignedTo: null`. Токеном техника создать → 403.

### Список и детали (обе роли)

```bash
curl -s "$API/v1/orders?status=new&limit=20" -H "Authorization: Bearer $AT" | jq
curl -s "$API/v1/orders/$ORDER_ID" -H "Authorization: Bearer $AT" | jq
```

Важная проверка изоляции: **техник видит только назначенные ему заявки**. Пока заявка не назначена:

```bash
curl -s "$API/v1/orders/$ORDER_ID" -H "Authorization: Bearer $TAT" -o /dev/null -w '%{http_code}\n'
# Ожидание: 404 (не 403 — чужая заявка не должна раскрывать своё существование)
```

### Назначить техника (dispatcher)

```bash
curl -s "$API/v1/orders/$ORDER_ID/assign" \
  -H "Authorization: Bearer $AT" \
  -H 'Content-Type: application/json' \
  -d "{\"technicianId\":\"$TECH_ID\"}" | jq
```

После этого техник получает доступ к заявке (повторить GET деталей токеном техника → 200). Если у техника зарегистрировано устройство (раздел 6) — уйдёт push.

### Правка полей (dispatcher)

```bash
curl -s -X PATCH "$API/v1/orders/$ORDER_ID" \
  -H "Authorization: Bearer $AT" \
  -H 'Content-Type: application/json' \
  -d '{"address":"ул. Ленина, 2","latitude":null,"longitude":null}' | jq
```

`null` в координатах снимает точку с карты. Статус через PATCH менять нельзя — только transition.

### Переходы статуса (обе роли)

Конечный автомат: `new → in_progress → done`, отмена из `new`/`in_progress`. `baseStatus` — снимок состояния у клиента, для конфликт-детекции.

```bash
# Техник берёт в работу
curl -s "$API/v1/orders/$ORDER_ID/transition" \
  -H "Authorization: Bearer $TAT" \
  -H 'Content-Type: application/json' \
  -d '{"to":"in_progress","baseStatus":"new"}' | jq

# Недопустимый переход: done → new не существует; также устаревший baseStatus → 409
curl -s "$API/v1/orders/$ORDER_ID/transition" \
  -H "Authorization: Bearer $TAT" \
  -H 'Content-Type: application/json' \
  -d '{"to":"done","baseStatus":"new"}' -o /dev/null -w '%{http_code}\n'
# Ожидание: 409 (baseStatus уже не совпадает с фактическим in_progress)
```

## 4. Фото (технику по своей заявке)

Multipart-загрузка. Заголовок `Idempotency-Key` **обязателен** (без него — 422); повтор с тем же ключом вернёт 200 и то же фото (первая загрузка — 201).

```bash
KEY=$(uuidgen)
PHOTO=$(curl -s "$API/v1/orders/$ORDER_ID/photos" \
  -H "Authorization: Bearer $TAT" \
  -H "Idempotency-Key: $KEY" \
  -F "file=@/path/to/photo.jpg;type=image/jpeg" \
  -F "takenAt=2026-07-15T10:30:00Z" \
  -F "comment=До начала работ")
echo "$PHOTO" | jq
export PHOTO_ID=$(echo "$PHOTO" | jq -r .id)
```

Негативные кейсы: без `takenAt` → 422; не-изображение (`type=text/plain`) → 415; файл больше лимита → 413; чужая заявка → 404.

Ожидание после загрузки: `status: "staged"` — фото становится `committed` только через sync-мутацию `photo_add` (раздел 5).

### Скачать файл

```bash
curl -s -i "$API/v1/photos/$PHOTO_ID/file" -H "Authorization: Bearer $TAT" | head -20
# Ожидание: 302 с Location на presigned URL storage.<домен>
curl -s -L "$API/v1/photos/$PHOTO_ID/file" -H "Authorization: Bearer $TAT" -o /tmp/downloaded.jpg
file /tmp/downloaded.jpg   # должен быть JPEG
```

Проверяет заодно и Caddy/TLS для `DOMAIN_STORAGE`, и presigned-выдачу MinIO.

## 5. Синхронизация (только technician)

Токеном диспетчера оба эндпоинта → 403.

### Pull

```bash
curl -s "$API/v1/sync/orders?cursor=0&limit=100" -H "Authorization: Bearer $TAT" | jq
```

Ожидание: `items` c элементами `type: "order"` (заявка + её committed-фото) и `nextCursor`. Повторный запрос с `cursor=<nextCursor>` → пустой `items` (ничего нового). Если диспетчер переназначит заявку другому технику — в pull первого техника придёт tombstone `type: "unassigned"`.

### Мутации (идемпотентный батч)

```bash
MUT_ID=$(uuidgen)
curl -s "$API/v1/sync/mutations" \
  -H "Authorization: Bearer $TAT" \
  -H 'Content-Type: application/json' \
  -d "{
    \"mutations\": [
      {\"mutationId\":\"$MUT_ID\",\"type\":\"status_change\",\"orderId\":\"$ORDER_ID\",\"to\":\"done\",\"baseStatus\":\"in_progress\"},
      {\"mutationId\":\"$(uuidgen)\",\"type\":\"photo_add\",\"orderId\":\"$ORDER_ID\",\"photoId\":\"$PHOTO_ID\"}
    ]
  }" | jq
```

Ожидание: `verdicts` с `result: "applied"` по каждой мутации; у `status_change` — снимок заявки. Ключевые проверки:

- **повтор того же батча** (те же `mutationId`) → `result: "duplicate"`, состояние не меняется;
- мутация с несовпадающим `baseStatus` → `result: "conflict"` + снимок актуального состояния;
- мутация по чужой заявке или с мусорным uuid → `result: "rejected"` (batch целиком не падает);
- после `photo_add` фото в деталях заявки становится `committed`.

## 6. Устройства для push (обе роли)

```bash
curl -s -X PUT "$API/v1/devices" \
  -H "Authorization: Bearer $TAT" \
  -H 'Content-Type: application/json' \
  -d '{"expoPushToken":"ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]"}' | jq
```

Невалидный формат токена (не ExpoPushToken) → 422. Реальную доставку push можно проверить только с настоящим токеном из Expo-приложения и заполненным `EXPO_ACCESS_TOKEN`; факт постановки в outbox и работу worker'а видно в логах api (`docker compose ... logs -f api | grep -i push`).

## 7. Сквозные проверки безопасности

Быстрый чек-лист (все — ожидаемо «отказ»):

```bash
# Без токена
curl -s "$API/v1/orders" -o /dev/null -w '%{http_code}\n'                      # 401
# Мусорный/просроченный JWT
curl -s "$API/v1/orders" -H 'Authorization: Bearer garbage' -o /dev/null -w '%{http_code}\n'  # 401
# Технику — диспетчерские ручки
curl -s "$API/v1/users" -H "Authorization: Bearer $TAT" \
  -H 'Content-Type: application/json' -d '{}' -o /dev/null -w '%{http_code}\n' # 403
# Неизвестный маршрут
curl -s "$API/v1/nope" -o /dev/null -w '%{http_code}\n'                        # 404
# HTTP → HTTPS редирект Caddy
curl -s -I "http://api.вашдомен.ru/v1/health" | head -3                        # 308/301 на https
```

Все ошибки должны приходить в едином конверте `{ "code": "...", "message": "..." }` с английским кодом-константой.

## 8. Метрики и мониторинг

```bash
ssh -L 9090:localhost:9090 deploy@<сервер>
# затем в браузере http://localhost:9090 — target api:3000/metrics должен быть UP
```

После прогона тестов в Prometheus видны `http_request_duration_seconds` по роутам и коды ответов — можно убедиться, что 4xx из негативных кейсов посчитались, а алёрт «5xx > 1%» не сработал.

## Порядок полного прогона (сводка)

1. Health + закрытость портов (раздел 0).
2. Логин диспетчера, refresh-ротация, reuse-защита (раздел 1).
3. Создание техника, деактивация/реактивация, логин техника (раздел 2).
4. Заявка: create → 404 для чужого техника → assign → 200 для своего → patch → transition, конфликт по `baseStatus` (раздел 3).
5. Фото: multipart + идемпотентный повтор, 302 на presigned URL (раздел 4).
6. Sync: pull с курсором, батч мутаций, duplicate/conflict/rejected (раздел 5).
7. PUT /v1/devices (раздел 6).
8. Чек-лист безопасности + метрики (разделы 7–8).

## Смежные страницы

- [Развёртывание на VPS](vps-deployment-guide.md) — как поднять стек, который здесь проверяется.
- [Деплой](deployment.md) — устройство продакшн-стека.
- [Аудит OWASP API Top 10](security-audit-owasp-api-top10.md) — какие свойства проверяет чек-лист безопасности.
