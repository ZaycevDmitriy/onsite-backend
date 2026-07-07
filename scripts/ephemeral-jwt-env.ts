import { generateKeyPairSync } from 'node:crypto';

/**
 * Эпемерная пара RS256 + дамми S3-значения для оффлайн-скриптов (migrate/seed/openapi:print/validate):
 * реальные ключи и S3 не нужны — JWT не выпускаются, S3-клиенты не ходят в сеть при создании
 * (решение #13 плана фазы 4). Значения из process.env имеют приоритет.
 */
export const makeEphemeralJwtEnv = (): Record<string, string> => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });

  return {
    JWT_PRIVATE_KEY: Buffer.from(privateKey, 'utf8').toString('base64'),
    JWT_PUBLIC_KEY: Buffer.from(publicKey, 'utf8').toString('base64'),
    S3_ENDPOINT: 'http://localhost:9000',
    S3_ACCESS_KEY: 'unused',
    S3_SECRET_KEY: 'unused',
    S3_BUCKET: 'unused',
  };
};
