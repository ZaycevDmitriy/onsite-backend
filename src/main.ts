import { buildApp } from '@/app.js';
import { cleanupOrphanStagedPhotos } from '@/modules/photos/index.js';
import { loadConfig } from '@/shared/config/index.js';

// Точка входа: конфиг → приложение → listen → graceful shutdown.
const config = loadConfig();
const app = await buildApp(config);

// Останов по сигналам: app.close() гасит HTTP и onClose-хуки (в т.ч. пул БД и таймер зачистки).
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.log.info({ signal }, 'получен сигнал остановки');
    void app.close().then(() => process.exit(0));
  });
}

// Зачистка staged-сирот (T-13): первый прогон при старте, далее — по интервалу из конфига.
const runPhotoCleanup = async (): Promise<void> => {
  try {
    await cleanupOrphanStagedPhotos(app.db, app.s3, config.photoStagedTtlHours, app.log);
  } catch (error) {
    app.log.error({ err: error }, 'ошибка прогона зачистки staged-фото');
  }
};

const photoCleanupTimer = setInterval(
  () => void runPhotoCleanup(),
  config.photoCleanupIntervalMin * 60_000,
);

app.addHook('onClose', () => {
  clearInterval(photoCleanupTimer);
});

void runPhotoCleanup();

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.fatal({ err: error }, 'не удалось запустить сервер');
  process.exit(1);
}
