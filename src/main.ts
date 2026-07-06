import { buildApp } from '@/app.js';
import { loadConfig } from '@/shared/config/index.js';

// Точка входа: конфиг → приложение → listen → graceful shutdown.
const config = loadConfig();
const app = await buildApp(config);

// Останов по сигналам: app.close() гасит HTTP и onClose-хуки (в т.ч. пул БД).
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.log.info({ signal }, 'получен сигнал остановки');
    void app.close().then(() => process.exit(0));
  });
}

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.fatal({ err: error }, 'не удалось запустить сервер');
  process.exit(1);
}
