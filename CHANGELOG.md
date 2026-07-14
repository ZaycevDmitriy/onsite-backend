## [1.8.1](https://github.com/ZaycevDmitriy/onsite-backend/compare/v1.8.0...v1.8.1) (2026-07-14)


### Bug Fixes

* **auth:** переносить auth-хуки с preHandler на onRequest ([967cff4](https://github.com/ZaycevDmitriy/onsite-backend/commit/967cff4252f104e1c0bf47542c05d4db0281980c))
* **errors:** отдавать наружу message только собственных 4xx-ошибок Fastify ([2cde8d3](https://github.com/ZaycevDmitriy/onsite-backend/commit/2cde8d3562317866de6dbbaa20783323356f807d))
* **errors:** уточнить семантику FST_-фильтра и warn-лог сторонних 4xx ([10aa7fd](https://github.com/ZaycevDmitriy/onsite-backend/commit/10aa7fd782694c5cf2236f7e4d9a06cb3c98b01e))

# [1.8.0](https://github.com/ZaycevDmitriy/onsite-backend/compare/v1.7.1...v1.8.0) (2026-07-13)


### Bug Fixes

* **auth:** брать isActive из записи пользователя в ответе логина ([deb5915](https://github.com/ZaycevDmitriy/onsite-backend/commit/deb5915e16c994fdd5eb60b6b1f0363a8e888279))


### Features

* **auth:** добавить профиль пользователя в ответ логина ([f21d94d](https://github.com/ZaycevDmitriy/onsite-backend/commit/f21d94db2d56c6fe0eebe37f5a3e019a68fbceb8))
* **http:** эхо x-request-id в заголовке каждого ответа ([afe8017](https://github.com/ZaycevDmitriy/onsite-backend/commit/afe8017b515b4213ca5e564df128cf9ca356ce2b))

## [1.7.1](https://github.com/ZaycevDmitriy/onsite-backend/compare/v1.7.0...v1.7.1) (2026-07-12)


### Bug Fixes

* **config:** пустая строка env трактуется как отсутствие значения ([62f3518](https://github.com/ZaycevDmitriy/onsite-backend/commit/62f3518c79307d26dee59c62732ec4a8d6202a09))
* **deploy:** ретеншн бэкапов MinIO без find ([f4f79a6](https://github.com/ZaycevDmitriy/onsite-backend/commit/f4f79a6f4ee39d43a8f92c6de316eabbeaaf5722))
* **errors:** клиентские 4xx-ошибки Fastify не маскируются под 500 ([ff6add8](https://github.com/ZaycevDmitriy/onsite-backend/commit/ff6add8e389c728eb206aa965d8d72be9a384188))

# [1.7.0](https://github.com/ZaycevDmitriy/onsite-backend/compare/v1.6.1...v1.7.0) (2026-07-08)


### Bug Fixes

* **cli:** create-first-user принимает вход только через env ([c82bdcd](https://github.com/ZaycevDmitriy/onsite-backend/commit/c82bdcd897bd0183c934bfc68ceae58011bf0b18))
* **cli:** email-валидация create-first-user — точное зеркало ajv-formats ([3466833](https://github.com/ZaycevDmitriy/onsite-backend/commit/34668335ed00c354053dbd2240dae57a37cc51c8))


### Features

* **cli:** перенос migrate в src/cli и скрипт создания первого диспетчера ([b8e0562](https://github.com/ZaycevDmitriy/onsite-backend/commit/b8e0562ba4512e1749dc85e5474598cc46d1b542))
* **deploy:** прод-стек из GHCR-образа, healthcheck api и ротация логов ([c0bbf0c](https://github.com/ZaycevDmitriy/onsite-backend/commit/c0bbf0c8ef534003f20bbc54cc24ec206a2ebdc3))

## [1.6.1](https://github.com/ZaycevDmitriy/onsite-backend/compare/v1.6.0...v1.6.1) (2026-07-08)


### Bug Fixes

* замечания ревью PR [#5](https://github.com/ZaycevDmitriy/onsite-backend/issues/5) — индекс expires_at и лимит интервалов ([80ebe56](https://github.com/ZaycevDmitriy/onsite-backend/commit/80ebe5694d84797331bfd5f115a855b7bcab7d73))

# [1.6.0](https://github.com/ZaycevDmitriy/onsite-backend/compare/v1.5.1...v1.6.0) (2026-07-08)


### Bug Fixes

* **security:** закрыть low-находки аудита — отзыв сессий при деактивации, пиннинг RS256, trustProxy: 1 ([a5e338c](https://github.com/ZaycevDmitriy/onsite-backend/commit/a5e338c0d2dedf79c721ef1cca4080f8a971f5a9))


### Features

* зачистка просроченных refresh_sessions ([f60058d](https://github.com/ZaycevDmitriy/onsite-backend/commit/f60058d9e5dcdd1335f19b0082c0570e9c27090d))

## [1.5.1](https://github.com/ZaycevDmitriy/onsite-backend/compare/v1.5.0...v1.5.1) (2026-07-08)


### Bug Fixes

* уникальный индекс на refresh_sessions.token_hash ([334eeda](https://github.com/ZaycevDmitriy/onsite-backend/commit/334eeda46500ef09126cf76b966056e059aa9c10))

# [1.5.0](https://github.com/ZaycevDmitriy/onsite-backend/compare/v1.4.0...v1.5.0) (2026-07-07)


### Bug Fixes

* hardening по итогам security-аудита ([9d4b5c1](https://github.com/ZaycevDmitriy/onsite-backend/commit/9d4b5c1b2140e86532d5762a74203fe0706d2c12))
* requiredClaims для iss/aud, негативный тест и allowlist хостов БД в сиде ([9a5163e](https://github.com/ZaycevDmitriy/onsite-backend/commit/9a5163e5ff43027e3c082dbad8400bb6940f6c90))


### Features

* push-worker — outbox, отправка в Expo, receipt'ы и деактивация мёртвых токенов ([70b2b98](https://github.com/ZaycevDmitriy/onsite-backend/commit/70b2b98bf60f9c18b4726e688a5644b2a84347ef))
* rate limiting и Prometheus-метрики с алёрт-правилом 5xx ([0d5b52c](https://github.com/ZaycevDmitriy/onsite-backend/commit/0d5b52cfcff4d786e13a884132f47e29541b6877))
* регистрация устройств для push-уведомлений ([a7c04ae](https://github.com/ZaycevDmitriy/onsite-backend/commit/a7c04ae8ec53309c5893ad53ccd42ac74c342c67))

# [1.4.0](https://github.com/ZaycevDmitriy/onsite-backend/compare/v1.3.0...v1.4.0) (2026-07-07)


### Bug Fixes

* скоупинг идемпотентности sync-мутаций по userId и минимальная длина пароля 12 ([8bcbbfb](https://github.com/ZaycevDmitriy/onsite-backend/commit/8bcbbfb29422931a374cd22397a3b9f2a6953f87))


### Features

* pull-синхронизация заявок по курсору с tombstone и safety-lag ([29d03bc](https://github.com/ZaycevDmitriy/onsite-backend/commit/29d03bc74a92d4d1a036a778943730707fac7653))
* приём батча офлайн-мутаций с идемпотентностью и вердиктами ([7a30caa](https://github.com/ZaycevDmitriy/onsite-backend/commit/7a30caa52f616ff510d2e335ed515760542f53aa))
* расширение публичных API orders и photos под синк-протокол ([3bc228c](https://github.com/ZaycevDmitriy/onsite-backend/commit/3bc228cbcff87ccd5259358db8c1e7b4555771b6))

# [1.3.0](https://github.com/ZaycevDmitriy/onsite-backend/compare/v1.2.0...v1.3.0) (2026-07-07)


### Bug Fixes

* устранение замечаний security-аудита фото и лимитера логина ([705e228](https://github.com/ZaycevDmitriy/onsite-backend/commit/705e228bdf3ca9312025418c8525d3c6f3c9c18a))


### Features

* домен, схемы, сервис и роуты staged-загрузки фото, выдача через presigned URL и зачистка сирот ([0efa9fe](https://github.com/ZaycevDmitriy/onsite-backend/commit/0efa9fe5cdf762982916655b2e6443ccc5ba5997))
* конфиг S3, s3-плагин, коды ошибок и unique-индекс storage_key ([58a96a6](https://github.com/ZaycevDmitriy/onsite-backend/commit/58a96a68d2637827d06730212e54c35ebfe615b5))

# [1.2.0](https://github.com/ZaycevDmitriy/onsite-backend/compare/v1.1.0...v1.2.0) (2026-07-07)


### Bug Fixes

* замечания ревью фазы 3 — FOR SHARE при назначении и nullable-координаты в PATCH ([98299d3](https://github.com/ZaycevDmitriy/onsite-backend/commit/98299d32240172c9a5d3acdcc96a3bacb06673ab))
* запрет самодеактивации диспетчера в PATCH /v1/users/:id ([08a8afe](https://github.com/ZaycevDmitriy/onsite-backend/commit/08a8afe119bda44f6d39a05d6fd82ec8954dc4fb))


### Features

* CRUD заявок, назначение с историей и автомат статусов ([7636a1a](https://github.com/ZaycevDmitriy/onsite-backend/commit/7636a1a5a5ca1c9027d4f23c5cbfa406dae79f6c))
* домен, схемы и repository модуля заявок ([8480a23](https://github.com/ZaycevDmitriy/onsite-backend/commit/8480a235bce179c6e35b9fb937f87b8d8c519bb2))

# [1.1.0](https://github.com/ZaycevDmitriy/onsite-backend/compare/v1.0.1...v1.1.0) (2026-07-07)


### Bug Fixes

* выравнивание тайминга логина и защита от конкурентной ротации refresh ([4d59dae](https://github.com/ZaycevDmitriy/onsite-backend/commit/4d59dae38658407a013983a8109fc64335f3df86))
* конкурентное создание пользователя с занятым email — 409 вместо 500 ([9e49b04](https://github.com/ZaycevDmitriy/onsite-backend/commit/9e49b04f40a323a1ffb2809d48bef37595089890))


### Features

* конфиг JWT RS256, auth-плагин и сервис пользователей ([e1246db](https://github.com/ZaycevDmitriy/onsite-backend/commit/e1246db4b08eaa54467ebb870530537cef37deed))
* логин с ротацией refresh, logout и управление пользователями ([da9fa24](https://github.com/ZaycevDmitriy/onsite-backend/commit/da9fa24fa280434573619b6a0c7e50b0761c1937))

## [1.0.1](https://github.com/ZaycevDmitriy/onsite-backend/compare/v1.0.0...v1.0.1) (2026-07-06)


### Bug Fixes

* таймауты пула pg, симметричный upsert сида и seed-тесты по фиксированным UUID ([970de07](https://github.com/ZaycevDmitriy/onsite-backend/commit/970de07a9e7e378d5f93078b568bdbb4fdd3c7a7))

# 1.0.0 (2026-07-06)


### Features

* Docker Compose (api/pg/minio) и Dockerfile ([e4aa565](https://github.com/ZaycevDmitriy/onsite-backend/commit/e4aa565e559da1035f13abafeb911a0c83b965ce))
* каркас Fastify, конверт ошибок, /v1/health и OpenAPI ([6896e5a](https://github.com/ZaycevDmitriy/onsite-backend/commit/6896e5ac96dad8a3b7499a019f4415f222afdca7))
* схема БД Drizzle, миграции и идемпотентный сид ([7262fcb](https://github.com/ZaycevDmitriy/onsite-backend/commit/7262fcbfbfe00b072543a42ceb38aba417cae1af))
