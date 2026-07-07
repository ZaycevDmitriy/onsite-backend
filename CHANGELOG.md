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
