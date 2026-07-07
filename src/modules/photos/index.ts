// Публичный API модуля photos: единственная точка импорта для соседей.
export { PhotoStatusEnum } from './db-schema.js';
export { photosRoutes, type IPhotosRoutesOptions } from './routes.js';
export {
  findStagedPhotoForCommit,
  getPhotoFileLocation,
  uploadStagedPhoto,
  cleanupOrphanStagedPhotos,
  listCommittedPhotosByOrderId,
  type ICleanupResult,
  type IPhotoFileLocation,
  type IPhotoRequester,
  type IPhotoView,
  type IUploadStagedPhotoInput,
  type IUploadStagedPhotoResult,
} from './service.js';
