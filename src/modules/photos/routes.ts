import multipart from '@fastify/multipart';

import { AppError, ErrorCodeEnum, errorEnvelopeSchema } from '@/shared/errors/index.js';

import {
  orderIdParamsSchema,
  photoFileRedirectResponseSchema,
  photoIdParamsSchema,
  photoViewSchema,
  uploadPhotoHeadersSchema,
} from './schemas.js';
import { getPhotoFileLocation, uploadStagedPhoto } from './service.js';

import type { MultipartFile } from '@fastify/multipart';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';

export interface IPhotosRoutesOptions {
  maxFileSizeBytes: number;
  presignTtlSec: number;
}

// Запас поверх лимита файла: multipart-обёртка (границы, заголовки, поля формы) — не только бинарник.
const MULTIPART_BODY_LIMIT_OVERHEAD_BYTES = 1024 * 1024;

const isRequestFileTooLargeError = (error: unknown): boolean =>
  error instanceof Error && (error as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE';

/** Читает значение текстового поля multipart-формы (fields заполняются после toBuffer(), решение #5). */
const readMultipartFieldValue = (file: MultipartFile, name: string): string | undefined => {
  const field = file.fields[name];

  if (field === undefined || Array.isArray(field) || field.type !== 'field') {
    return undefined;
  }

  return String(field.value);
};

// Фото: staged-загрузка (multipart) и выдача файла через presigned URL (FR-11, FR-12).
export const photosRoutes: FastifyPluginAsyncTypebox<IPhotosRoutesOptions> = async (
  app,
  options,
) => {
  // Multipart скоуплен внутри photosRoutes — не регистрируется глобально (решение #5).
  await app.register(multipart, {
    limits: { fileSize: options.maxFileSizeBytes },
  });

  app.post(
    '/v1/orders/:id/photos',
    {
      preHandler: [app.authenticate],
      bodyLimit: options.maxFileSizeBytes + MULTIPART_BODY_LIMIT_OVERHEAD_BYTES,
      schema: {
        tags: ['photos'],
        security: [{ bearerAuth: [] }],
        consumes: ['multipart/form-data'],
        params: orderIdParamsSchema,
        headers: uploadPhotoHeadersSchema,
        response: {
          200: photoViewSchema,
          201: photoViewSchema,
          401: errorEnvelopeSchema,
          404: errorEnvelopeSchema,
          409: errorEnvelopeSchema,
          413: errorEnvelopeSchema,
          415: errorEnvelopeSchema,
          422: errorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const file = await request.file();

      if (file === undefined) {
        request.log.debug('загрузка фото отклонена: файл отсутствует');
        throw new AppError(422, ErrorCodeEnum.ValidationFailed, 'File is required');
      }

      // toBuffer() дренирует весь multipart-стрим: только после этого file.fields содержит
      // поля, объявленные в форме ПОСЛЕ файла (ограничение потокового режима busboy). Кроме того,
      // превышение лимита размера должно диагностироваться раньше отсутствующих полей формы.
      let fileBuffer: Buffer;
      try {
        fileBuffer = await file.toBuffer();
      } catch (error) {
        if (isRequestFileTooLargeError(error)) {
          request.log.debug('загрузка фото отклонена: файл превышает лимит размера');
          throw new AppError(413, ErrorCodeEnum.FileTooLarge, 'File too large');
        }
        throw error;
      }

      const takenAtRaw = readMultipartFieldValue(file, 'takenAt');

      if (takenAtRaw === undefined) {
        request.log.debug('загрузка фото отклонена: takenAt отсутствует');
        throw new AppError(422, ErrorCodeEnum.ValidationFailed, 'takenAt is required');
      }

      const takenAt = new Date(takenAtRaw);

      if (Number.isNaN(takenAt.getTime())) {
        request.log.debug({ takenAtRaw }, 'загрузка фото отклонена: takenAt не ISO-дата');
        throw new AppError(422, ErrorCodeEnum.ValidationFailed, 'Invalid takenAt');
      }

      const comment = readMultipartFieldValue(file, 'comment');

      const { photo, created } = await uploadStagedPhoto(
        app.db,
        app.s3,
        {
          orderId: request.params.id,
          idempotencyKey: request.headers['idempotency-key'],
          mimeType: file.mimetype,
          fileBuffer,
          ...(comment !== undefined ? { comment } : {}),
          takenAt,
        },
        request.user,
        request.log,
      );

      return reply.code(created ? 201 : 200).send(photo);
    },
  );

  app.get(
    '/v1/photos/:id/file',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['photos'],
        security: [{ bearerAuth: [] }],
        params: photoIdParamsSchema,
        response: {
          302: photoFileRedirectResponseSchema,
          401: errorEnvelopeSchema,
          404: errorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const { url } = await getPhotoFileLocation(
        app.db,
        app.s3,
        request.params.id,
        request.user,
        options.presignTtlSec,
        request.log,
      );

      return reply.code(302).header('location', url).send(null);
    },
  );
};
