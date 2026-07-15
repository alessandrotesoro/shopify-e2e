export const MAX_METADATA_BYTES = 16 * 1024;
export {
	MAX_STORAGE_STATE_BYTES,
	type PlaywrightStorageState,
	type StorageStateCookie,
	type StorageStateOrigin,
	serializeStorageState,
	validateParsedStorageState,
	validateStorageState,
} from "../storage-state/schema.cjs";
