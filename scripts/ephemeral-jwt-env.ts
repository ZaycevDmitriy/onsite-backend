import { generateKeyPairSync } from 'node:crypto';

/**
 * Эпемерная пара RS256 для оффлайн-скриптов (openapi:print/validate):
 * реальные ключи не нужны, JWT не выпускаются — только сборка приложения.
 * Значения из process.env имеют приоритет.
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
  };
};
