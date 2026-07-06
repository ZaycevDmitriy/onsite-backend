import { drizzle } from 'drizzle-orm/node-postgres';
import fp from 'fastify-plugin';

import { createPool } from './pool.js';

import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type pg from 'pg';

declare module 'fastify' {
  interface FastifyInstance {
    pg: pg.Pool;
    db: NodePgDatabase;
  }
}

export interface IDbPluginOptions {
  databaseUrl: string;
}

/**
 * Плагин БД: пул pg + Drizzle-клиент на инстансе Fastify.
 * Пул закрывается в onClose — app.close() гасит и HTTP, и соединения с БД.
 */
export const dbPlugin = fp<IDbPluginOptions>(
  // eslint-disable-next-line @typescript-eslint/require-await -- Сигнатура async-плагина Fastify.
  async (app, options) => {
    const pool = createPool(options.databaseUrl);

    app.log.debug('пул PostgreSQL создан');
    app.decorate('pg', pool);
    app.decorate('db', drizzle(pool));

    app.addHook('onClose', async () => {
      app.log.info('закрытие пула PostgreSQL');
      await pool.end();
    });
  },
  { name: 'db' },
);
