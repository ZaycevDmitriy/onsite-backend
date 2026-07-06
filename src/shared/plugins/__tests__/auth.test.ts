import { generateKeyPairSync } from 'node:crypto';

import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { errorHandler } from '@/shared/errors/index.js';
import { authPlugin, type IAuthenticatedUser } from '@/shared/plugins/index.js';

import type { FastifyInstance } from 'fastify';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const dispatcher: IAuthenticatedUser = {
  id: '018f2c3a-9c1e-7abc-8def-0123456789ab',
  role: 'dispatcher',
};
const technician: IAuthenticatedUser = {
  id: '018f2c3a-9c1e-7abc-8def-0123456789ac',
  role: 'technician',
};

// Активные пользователи мокируются: юнит-тест плагина не ходит в БД.
const activeUsers = new Map<string, IAuthenticatedUser>([
  [dispatcher.id, dispatcher],
  [technician.id, technician],
]);

const getActiveUser = vi.fn(
  // eslint-disable-next-line @typescript-eslint/require-await -- Мок async-контракта.
  async (userId: string): Promise<IAuthenticatedUser | null> => activeUsers.get(userId) ?? null,
);

describe('authPlugin', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    app.setErrorHandler(errorHandler);
    await app.register(authPlugin, {
      privateKey,
      publicKey,
      accessTokenTtlSec: 900,
      getActiveUser,
    });

    app.get('/protected', { preHandler: [app.authenticate] }, (request) => request.user);
    app.get(
      '/dispatcher-only',
      { preHandler: [app.authenticate, app.requireRole('dispatcher')] },
      () => ({ ok: true }),
    );
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const signFor = (user: IAuthenticatedUser): string =>
    app.jwt.sign({ sub: user.id, role: user.role });

  it('без токена → 401 unauthorized', async () => {
    const response = await app.inject({ method: 'GET', url: '/protected' });

    expect(response.statusCode).toBe(401);
    expect(response.json<{ code: string }>().code).toBe('unauthorized');
  });

  it('с мусорным токеном → 401', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer not-a-jwt' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('с валидным токеном → 200 и request.user из БД', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${signFor(dispatcher)}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(dispatcher);
  });

  it('валидный токен деактивированного пользователя → 401 (FR-04)', async () => {
    const ghost: IAuthenticatedUser = {
      id: '018f2c3a-9c1e-7abc-8def-0123456789ad',
      role: 'technician',
    };
    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${signFor(ghost)}` },
    });

    expect(response.statusCode).toBe(401);
    expect(getActiveUser).toHaveBeenCalledWith(ghost.id);
  });

  it('просроченный токен → 401', async () => {
    const expired = app.jwt.sign(
      { sub: dispatcher.id, role: dispatcher.role },
      { expiresIn: '-1s' },
    );
    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${expired}` },
    });

    expect(response.statusCode).toBe(401);
  });

  it('requireRole: диспетчер проходит', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/dispatcher-only',
      headers: { authorization: `Bearer ${signFor(dispatcher)}` },
    });

    expect(response.statusCode).toBe(200);
  });

  it('requireRole: техник получает 403 forbidden', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/dispatcher-only',
      headers: { authorization: `Bearer ${signFor(technician)}` },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json<{ code: string }>().code).toBe('forbidden');
  });
});
