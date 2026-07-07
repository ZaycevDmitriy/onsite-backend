import { S3Client } from '@aws-sdk/client-s3';
import fp from 'fastify-plugin';

declare module 'fastify' {
  interface FastifyInstance {
    s3: IS3Decoration;
  }
}

// Декорация app.s3: внутренний клиент — операции с объектами, публичный — только подпись URL (решение #8).
export interface IS3Decoration {
  client: S3Client;
  presignClient: S3Client;
  bucket: string;
}

export interface IS3PluginOptions {
  endpoint: string;
  publicEndpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

/**
 * Плагин S3/MinIO: декорирует app.s3 двумя клиентами (forcePathStyle — MinIO не поддерживает
 * virtual-hosted-style адресацию) и именем бакета. Клиенты не ходят в сеть при создании.
 */
export const s3Plugin = fp<IS3PluginOptions>(
  // eslint-disable-next-line @typescript-eslint/require-await -- Сигнатура async-плагина Fastify.
  async (app, options) => {
    const credentials = {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
    };

    const client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      credentials,
      forcePathStyle: true,
    });

    const presignClient = new S3Client({
      endpoint: options.publicEndpoint,
      region: options.region,
      credentials,
      forcePathStyle: true,
    });

    app.decorate('s3', { client, presignClient, bucket: options.bucket });

    app.addHook('onClose', () => {
      app.log.info('закрытие S3-клиентов');
      client.destroy();
      presignClient.destroy();
    });

    app.log.debug({ bucket: options.bucket }, 's3-плагин зарегистрирован');
  },
  { name: 's3' },
);
