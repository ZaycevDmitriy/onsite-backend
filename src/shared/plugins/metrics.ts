import { collectDefaultMetrics, Gauge, Histogram, Registry } from 'prom-client';
import fp from 'fastify-plugin';

export interface IMetricsPluginOptions {
  // Глубина outbox по статусам (T-20, решение #4 фазы 6): инъекция из @/modules/notifications
  // композиционным корнем — shared не импортирует modules.
  countOutboxByStatus: () => Promise<Record<string, number>>;
}

/**
 * Prometheus-метрики (NFR-11): `/metrics` без auth, защита — непубликация порта наружу
 * в production-компоузе (решение #5 фазы 6). Histogram латентностей — по route-шаблону
 * (`request.routeOptions.url`), не по сырому пути: id в URL иначе дают unbounded cardinality.
 */
export const metricsPlugin = fp<IMetricsPluginOptions>(
  // eslint-disable-next-line @typescript-eslint/require-await -- Сигнатура async-плагина Fastify.
  async (app, options) => {
    const registry = new Registry();
    collectDefaultMetrics({ register: registry });

    const httpRequestDuration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'Длительность HTTP-запросов в секундах',
      labelNames: ['method', 'route', 'status_code'],
      registers: [registry],
    });

    new Gauge({
      name: 'push_outbox_depth',
      help: 'Глубина очереди push_outbox по статусам',
      labelNames: ['status'],
      registers: [registry],
      async collect() {
        const counts = await options.countOutboxByStatus();

        for (const [status, count] of Object.entries(counts)) {
          this.set({ status }, count);
        }
      },
    });

    app.addHook('onResponse', (request, reply, done) => {
      const route = request.routeOptions.url ?? 'unknown';
      httpRequestDuration.observe(
        { method: request.method, route, status_code: String(reply.statusCode) },
        reply.elapsedTime / 1000,
      );
      done();
    });

    app.get(
      '/metrics',
      { config: { rateLimit: false }, schema: { hide: true } },
      async (_request, reply) => {
        const body = await registry.metrics();

        return reply.header('content-type', registry.contentType).send(body);
      },
    );

    app.log.debug('metrics-плагин зарегистрирован');
  },
  { name: 'metrics' },
);
