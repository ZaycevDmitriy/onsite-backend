import { isUniqueViolation } from '@/shared/db/index.js';

import { buildSyncPage } from './domain.js';
import { SyncMutationResultEnum } from './db-schema.js';
import { findSyncMutationById, insertSyncMutation } from './repository.js';

import type {
  IBuildSyncPageResult,
  ISyncOrderPullItem,
  ISyncPullItem,
  ISyncUnassignedPullItem,
} from './domain.js';
import type {
  IOrderRequester,
  IOrderView,
  ISyncTransitionResult,
  IUnassignedTombstoneView,
  ServiceOrderStatusEnum,
} from '@/modules/orders/index.js';
import type { IPhotoView } from '@/modules/photos/index.js';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { FastifyBaseLogger } from 'fastify';

// Полезная нагрузка заявки в pull-элементе: заявка + её committed-фото (решение #2 фазы 5).
export interface ISyncOrderPayload extends IOrderView {
  photos: IPhotoView[];
}

export type ISyncPullItemView = ISyncPullItem<ISyncOrderPayload>;

// Функции orders/photos, инъецируемые composition root'ом (app.ts, паттерн listCommittedPhotos,
// решение #7 фазы 5) — sync не импортирует сервисы соседних модулей напрямую.
export type IListOrdersForSync = (
  db: NodePgDatabase,
  filters: { assignedTo: string; cursor: number; limit: number },
  logger: FastifyBaseLogger,
) => Promise<IOrderView[]>;

export type IListUnassignedTombstones = (
  db: NodePgDatabase,
  filters: { userId: string; cursor: number; limit: number },
  logger: FastifyBaseLogger,
) => Promise<IUnassignedTombstoneView[]>;

export type IGetCurrentSyncSeq = (db: NodePgDatabase) => Promise<number>;

export type IListCommittedPhotosByOrderIds = (
  db: NodePgDatabase,
  orderIds: string[],
) => Promise<Map<string, IPhotoView[]>>;

export interface IPullSyncDeps {
  listOrdersForSync: IListOrdersForSync;
  listUnassignedTombstones: IListUnassignedTombstones;
  getCurrentSyncSeq: IGetCurrentSyncSeq;
  listCommittedPhotosByOrderIds: IListCommittedPhotosByOrderIds;
}

export interface IPullSyncOptions {
  requesterId: string;
  cursor: number;
  limit: number;
  safetyLag: number;
}

export type IPullSyncResult = IBuildSyncPageResult<ISyncOrderPayload>;

/**
 * Собирает страницу pull-синхронизации техника (FR-08, T-10): заявки и tombstone читаются
 * с LIMIT limit+1 каждый, committed-фото — батчем без N+1, слияние и курсор — чистый домен sync.
 */
export const pullSync = async (
  db: NodePgDatabase,
  options: IPullSyncOptions,
  deps: IPullSyncDeps,
  logger: FastifyBaseLogger,
): Promise<IPullSyncResult> => {
  logger.debug(
    { requesterId: options.requesterId, cursor: options.cursor, limit: options.limit },
    'sync pull: старт',
  );

  const fetchLimit = options.limit + 1;

  const [orderRows, tombstoneRows, currentMaxSeq] = await Promise.all([
    deps.listOrdersForSync(
      db,
      { assignedTo: options.requesterId, cursor: options.cursor, limit: fetchLimit },
      logger,
    ),
    deps.listUnassignedTombstones(
      db,
      { userId: options.requesterId, cursor: options.cursor, limit: fetchLimit },
      logger,
    ),
    deps.getCurrentSyncSeq(db),
  ]);

  logger.debug(
    { orders: orderRows.length, tombstones: tombstoneRows.length, currentMaxSeq },
    'sync pull: сырые потоки получены',
  );

  const photosByOrderId = await deps.listCommittedPhotosByOrderIds(
    db,
    orderRows.map((row) => row.id),
  );

  const orderItems: ISyncOrderPullItem<ISyncOrderPayload>[] = orderRows.map((row) => ({
    type: 'order',
    seq: row.updatedSeq,
    order: { ...row, photos: photosByOrderId.get(row.id) ?? [] },
  }));

  const tombstoneItems: ISyncUnassignedPullItem[] = tombstoneRows.map((row) => ({
    type: 'unassigned',
    seq: row.seq,
    orderId: row.orderId,
  }));

  const page = buildSyncPage({
    orderItems,
    tombstoneItems,
    limit: options.limit,
    cursor: options.cursor,
    currentMaxSeq,
    safetyLag: options.safetyLag,
  });

  logger.info(
    { count: page.items.length, nextCursor: page.nextCursor },
    'sync pull: страница собрана',
  );

  return page;
};

// Транзакционный клиент — тот же tx открывается один раз на мутацию (db.transaction) и
// пробрасывается в инъецированные функции orders/photos (структурно совместим с их DbClient).
type TxClient = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0];

export interface IStatusChangeMutationInput {
  mutationId: string;
  type: 'status_change';
  orderId: string;
  to: ServiceOrderStatusEnum;
  baseStatus: ServiceOrderStatusEnum;
}

export interface IPhotoAddMutationInput {
  mutationId: string;
  type: 'photo_add';
  orderId: string;
  photoId: string;
}

export type ISyncMutationInput = IStatusChangeMutationInput | IPhotoAddMutationInput;

// Вердикт мутации в ответе батча: envelope {mutationId, result, order?} — то же, что хранится
// в sync_mutations.response (решение #3 фазы 5).
export interface ISyncMutationVerdict {
  mutationId: string;
  result: SyncMutationResultEnum;
  order?: IOrderView;
}

// Функции orders/photos, инъецируемые composition root'ом (паттерн listCommittedPhotos,
// решение #7 фазы 5) — sync применяет их внутри собственной транзакции мутации.
export type IApplySyncTransition = (
  tx: TxClient,
  orderId: string,
  input: { to: ServiceOrderStatusEnum; baseStatus: ServiceOrderStatusEnum },
  requester: IOrderRequester,
  logger: FastifyBaseLogger,
) => Promise<ISyncTransitionResult>;

export type IFindStagedPhotoForCommit = (
  tx: TxClient,
  photoId: string,
) => Promise<IPhotoView | null>;

export type ICommitStagedPhoto = (tx: TxClient, photoId: string) => Promise<IPhotoView | null>;

export type IRecordSyncPhotoAdded = (
  tx: TxClient,
  orderId: string,
  actorId: string,
  photoId: string,
  logger: FastifyBaseLogger,
) => Promise<IOrderView | null>;

export interface IApplyMutationBatchDeps {
  applySyncTransition: IApplySyncTransition;
  findStagedPhotoForCommit: IFindStagedPhotoForCommit;
  commitStagedPhoto: ICommitStagedPhoto;
  recordSyncPhotoAdded: IRecordSyncPhotoAdded;
}

/** Применяет мутацию status_change (FR-10, решение #5 фазы 5): вердикт от applySyncTransition. */
const processStatusChangeMutation = async (
  tx: TxClient,
  mutation: IStatusChangeMutationInput,
  requester: IOrderRequester,
  deps: IApplyMutationBatchDeps,
  logger: FastifyBaseLogger,
): Promise<ISyncMutationVerdict> => {
  const transition = await deps.applySyncTransition(
    tx,
    mutation.orderId,
    { to: mutation.to, baseStatus: mutation.baseStatus },
    requester,
    logger,
  );

  if (transition.result === 'rejected') {
    return { mutationId: mutation.mutationId, result: SyncMutationResultEnum.Rejected };
  }

  const result =
    transition.result === 'applied' ? SyncMutationResultEnum.Applied : SyncMutationResultEnum.Conflict;

  return { mutationId: mutation.mutationId, result, order: transition.order };
};

/**
 * Применяет мутацию photo_add (FR-09/FR-10, §5.6, решение #6 фазы 5): неизвестный/чужой/уже
 * committed photoId либо orderId мутации ≠ photos.orderId → rejected; иначе — коммит фото +
 * событие photo_added + bump updated_seq (заявка Cancelled/Done тоже applied).
 */
const processPhotoAddMutation = async (
  tx: TxClient,
  mutation: IPhotoAddMutationInput,
  requester: IOrderRequester,
  deps: IApplyMutationBatchDeps,
  logger: FastifyBaseLogger,
): Promise<ISyncMutationVerdict> => {
  const photo = await deps.findStagedPhotoForCommit(tx, mutation.photoId);

  if (photo === null || photo.authorId !== requester.id || photo.orderId !== mutation.orderId) {
    logger.debug(
      { mutationId: mutation.mutationId, photoId: mutation.photoId },
      'sync: photo_add отклонён — неизвестное/чужое/чужой заявки фото',
    );

    return { mutationId: mutation.mutationId, result: SyncMutationResultEnum.Rejected };
  }

  const committed = await deps.commitStagedPhoto(tx, mutation.photoId);

  if (committed === null) {
    logger.debug(
      { mutationId: mutation.mutationId, photoId: mutation.photoId },
      'sync: photo_add отклонён — фото уже не staged',
    );

    return { mutationId: mutation.mutationId, result: SyncMutationResultEnum.Rejected };
  }

  const order = await deps.recordSyncPhotoAdded(
    tx,
    mutation.orderId,
    requester.id,
    mutation.photoId,
    logger,
  );

  logger.info(
    { mutationId: mutation.mutationId, photoId: mutation.photoId },
    'sync: photo_add применён',
  );

  return {
    mutationId: mutation.mutationId,
    result: SyncMutationResultEnum.Applied,
    ...(order !== null ? { order } : {}),
  };
};

/** Вердикт хранимой мутации, приведённый к result: duplicate (решение #3 фазы 5). */
const toDuplicateVerdict = (response: unknown, mutationId: string): ISyncMutationVerdict => {
  const stored = response as Omit<ISyncMutationVerdict, 'result'>;

  return { ...stored, mutationId, result: SyncMutationResultEnum.Duplicate };
};

/**
 * Обрабатывает батч офлайн-мутаций (FR-09, FR-10, §5.6, решение #4 фазы 5): каждая мутация —
 * собственная транзакция (claim идемпотентности → применение → фиксация вердикта); сбой одной
 * мутации не блокирует остальные батча; гонка конкурентных батчей — перехват isUniqueViolation
 * при INSERT вердикта с перечитыванием уже зафиксированного результата.
 */
export const applyMutationBatch = async (
  db: NodePgDatabase,
  mutations: ISyncMutationInput[],
  requester: IOrderRequester,
  deps: IApplyMutationBatchDeps,
  logger: FastifyBaseLogger,
): Promise<ISyncMutationVerdict[]> => {
  logger.debug(
    { count: mutations.length, requesterId: requester.id },
    'sync: приём батча мутаций',
  );

  const verdicts: ISyncMutationVerdict[] = [];

  for (const mutation of mutations) {
    try {
      const verdict = await db.transaction(async (tx) => {
        const existing = await findSyncMutationById(tx, mutation.mutationId);

        if (existing !== null) {
          logger.debug({ mutationId: mutation.mutationId }, 'sync: мутация уже обработана');

          return toDuplicateVerdict(existing.response, mutation.mutationId);
        }

        const applied =
          mutation.type === 'status_change'
            ? await processStatusChangeMutation(tx, mutation, requester, deps, logger)
            : await processPhotoAddMutation(tx, mutation, requester, deps, logger);

        await insertSyncMutation(tx, {
          mutationId: mutation.mutationId,
          userId: requester.id,
          result: applied.result,
          response: applied,
        });

        return applied;
      });

      verdicts.push(verdict);
    } catch (error) {
      if (isUniqueViolation(error)) {
        logger.info(
          { mutationId: mutation.mutationId },
          'sync: гонка конкурентных батчей — перечитан ранее зафиксированный вердикт',
        );

        const existing = await findSyncMutationById(db, mutation.mutationId);

        verdicts.push(
          existing !== null
            ? toDuplicateVerdict(existing.response, mutation.mutationId)
            : { mutationId: mutation.mutationId, result: SyncMutationResultEnum.Rejected },
        );
        continue;
      }

      logger.error(
        { err: error, mutationId: mutation.mutationId },
        'sync: ошибка обработки мутации — вердикт rejected',
      );
      verdicts.push({ mutationId: mutation.mutationId, result: SyncMutationResultEnum.Rejected });
    }
  }

  logger.info({ count: verdicts.length }, 'sync: батч мутаций обработан');

  return verdicts;
};
