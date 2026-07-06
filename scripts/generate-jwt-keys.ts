import { generateKeyPairSync } from 'node:crypto';

// Генератор пары RSA-ключей для JWT RS256: печатает base64(PEM) для .env.
// Запуск: npx tsx scripts/generate-jwt-keys.ts
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const toBase64 = (pem: string): string => Buffer.from(pem, 'utf8').toString('base64');

process.stdout.write(`JWT_PRIVATE_KEY=${toBase64(privateKey)}\n`);
process.stdout.write(`JWT_PUBLIC_KEY=${toBase64(publicKey)}\n`);
