export const MAX_STORAGE_STATE_BYTES = 64 * 1024 * 1024;

export interface StorageStateCookie {
	readonly _crHasCrossSiteAncestor?: boolean;
	readonly domain: string;
	readonly expires: number;
	readonly httpOnly: boolean;
	readonly name: string;
	readonly partitionKey?: string;
	readonly path: string;
	readonly sameSite: "Lax" | "None" | "Strict";
	readonly secure: boolean;
	readonly value: string;
}

export interface StorageStateOrigin {
	readonly indexedDB?: readonly IndexedDBDatabase[];
	readonly localStorage: readonly {
		readonly name: string;
		readonly value: string;
	}[];
	readonly origin: string;
}

interface IndexedDBRecord {
	readonly key?: unknown;
	readonly keyEncoded?: unknown;
	readonly value?: unknown;
	readonly valueEncoded?: unknown;
}

interface IndexedDBIndex {
	readonly keyPath?: string;
	readonly keyPathArray?: readonly string[];
	readonly multiEntry: boolean;
	readonly name: string;
	readonly unique: boolean;
}

interface IndexedDBStore {
	readonly autoIncrement: boolean;
	readonly indexes: readonly IndexedDBIndex[];
	readonly keyPath?: string;
	readonly keyPathArray?: readonly string[];
	readonly name: string;
	readonly records: readonly IndexedDBRecord[];
}

interface IndexedDBDatabase {
	readonly name: string;
	readonly stores: readonly IndexedDBStore[];
	readonly version: number;
}

export interface PlaywrightStorageState {
	readonly cookies: readonly StorageStateCookie[];
	readonly origins: readonly StorageStateOrigin[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" &&
	value !== null &&
	!Array.isArray(value) &&
	(Object.getPrototypeOf(value) === Object.prototype ||
		Object.getPrototypeOf(value) === null);

const hasExactKeys = (
	value: Record<string, unknown>,
	required: readonly string[],
	optional: readonly string[] = [],
): boolean => {
	const keys = Object.keys(value);
	return (
		required.every((key) => keys.includes(key)) &&
		keys.every((key) => required.includes(key) || optional.includes(key))
	);
};

const isJsonValue = (value: unknown, depth = 0): boolean => {
	if (depth > 100) return false;
	if (value === null || typeof value === "string" || typeof value === "boolean")
		return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value))
		return value.every((item) => isJsonValue(item, depth + 1));
	if (!isRecord(value)) return false;
	return Object.values(value).every((item) => isJsonValue(item, depth + 1));
};

const hasAtMostOne = (
	value: Record<string, unknown>,
	left: string,
	right: string,
): boolean => !(Object.hasOwn(value, left) && Object.hasOwn(value, right));

const isStringArray = (value: unknown): value is readonly string[] =>
	Array.isArray(value) && value.every((item) => typeof item === "string");

const isIndexedDBRecord = (value: unknown): value is IndexedDBRecord => {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [], ["key", "keyEncoded", "value", "valueEncoded"]) ||
		!hasAtMostOne(value, "key", "keyEncoded") ||
		!hasAtMostOne(value, "value", "valueEncoded") ||
		(!Object.hasOwn(value, "value") && !Object.hasOwn(value, "valueEncoded"))
	)
		return false;
	return Object.values(value).every(isJsonValue);
};

const isIndexedDBIndex = (value: unknown): value is IndexedDBIndex => {
	if (
		!isRecord(value) ||
		!hasExactKeys(
			value,
			["name", "multiEntry", "unique"],
			["keyPath", "keyPathArray"],
		) ||
		!hasAtMostOne(value, "keyPath", "keyPathArray")
	)
		return false;
	return (
		typeof value.name === "string" &&
		typeof value.multiEntry === "boolean" &&
		typeof value.unique === "boolean" &&
		(value.keyPath === undefined || typeof value.keyPath === "string") &&
		(value.keyPathArray === undefined || isStringArray(value.keyPathArray))
	);
};

const isIndexedDBStore = (value: unknown): value is IndexedDBStore => {
	if (
		!isRecord(value) ||
		!hasExactKeys(
			value,
			["name", "autoIncrement", "records", "indexes"],
			["keyPath", "keyPathArray"],
		) ||
		!hasAtMostOne(value, "keyPath", "keyPathArray") ||
		!Array.isArray(value.records) ||
		!Array.isArray(value.indexes)
	)
		return false;
	return (
		typeof value.name === "string" &&
		typeof value.autoIncrement === "boolean" &&
		(value.keyPath === undefined || typeof value.keyPath === "string") &&
		(value.keyPathArray === undefined || isStringArray(value.keyPathArray)) &&
		value.records.every(isIndexedDBRecord) &&
		value.indexes.every(isIndexedDBIndex)
	);
};

const isIndexedDBDatabase = (value: unknown): value is IndexedDBDatabase => {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, ["name", "version", "stores"]) ||
		!Array.isArray(value.stores)
	)
		return false;
	return (
		typeof value.name === "string" &&
		Number.isSafeInteger(value.version) &&
		(value.version as number) > 0 &&
		value.stores.every(isIndexedDBStore)
	);
};

const isStorageCookie = (value: unknown): value is StorageStateCookie => {
	if (
		!isRecord(value) ||
		!hasExactKeys(
			value,
			[
				"name",
				"value",
				"domain",
				"path",
				"expires",
				"httpOnly",
				"secure",
				"sameSite",
			],
			["partitionKey", "_crHasCrossSiteAncestor"],
		)
	)
		return false;
	return (
		typeof value.name === "string" &&
		typeof value.value === "string" &&
		typeof value.domain === "string" &&
		typeof value.path === "string" &&
		typeof value.expires === "number" &&
		Number.isFinite(value.expires) &&
		typeof value.httpOnly === "boolean" &&
		typeof value.secure === "boolean" &&
		(value.partitionKey === undefined ||
			typeof value.partitionKey === "string") &&
		(value._crHasCrossSiteAncestor === undefined ||
			typeof value._crHasCrossSiteAncestor === "boolean") &&
		(value.sameSite === "Strict" ||
			value.sameSite === "Lax" ||
			value.sameSite === "None")
	);
};

const isStorageOrigin = (value: unknown): value is StorageStateOrigin => {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, ["origin", "localStorage"], ["indexedDB"]) ||
		typeof value.origin !== "string" ||
		!Array.isArray(value.localStorage)
	)
		return false;
	try {
		const url = new URL(value.origin);
		if (
			url.origin !== value.origin ||
			!["http:", "https:"].includes(url.protocol)
		)
			return false;
	} catch {
		return false;
	}
	if (
		!value.localStorage.every(
			(item) =>
				isRecord(item) &&
				hasExactKeys(item, ["name", "value"]) &&
				typeof item.name === "string" &&
				typeof item.value === "string",
		)
	)
		return false;
	return (
		value.indexedDB === undefined ||
		(Array.isArray(value.indexedDB) &&
			value.indexedDB.every(isIndexedDBDatabase))
	);
};

function assertStorageStateShape(
	value: unknown,
): asserts value is PlaywrightStorageState {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, ["cookies", "origins"]) ||
		!Array.isArray(value.cookies) ||
		!value.cookies.every(isStorageCookie) ||
		!Array.isArray(value.origins) ||
		!value.origins.every(isStorageOrigin)
	) {
		throw new TypeError("Playwright storage state is invalid");
	}
}

export const validateParsedStorageState = (
	value: unknown,
): PlaywrightStorageState => {
	assertStorageStateShape(value);
	return value;
};

const serializeBoundedJson = (value: unknown): string => {
	let serialized: string | undefined;
	try {
		serialized = JSON.stringify(value);
	} catch {
		throw new TypeError("Playwright storage state is invalid");
	}
	if (serialized === undefined) {
		throw new TypeError("Playwright storage state is invalid");
	}
	if (Buffer.byteLength(serialized) > MAX_STORAGE_STATE_BYTES) {
		throw new TypeError(
			"Playwright storage state is invalid or exceeds the 64 MiB limit",
		);
	}
	return serialized;
};

export const serializeStorageState = (value: unknown): string => {
	const serialized = serializeBoundedJson(value);
	validateParsedStorageState(JSON.parse(serialized) as unknown);
	return serialized;
};

export const validateStorageState = (value: unknown): PlaywrightStorageState =>
	validateParsedStorageState(
		JSON.parse(serializeStorageState(value)) as unknown,
	);
