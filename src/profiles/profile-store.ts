import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	open,
	readdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import type { ShopifyRoleConfig } from "../config/load-config.js";
import {
	ShopifyE2EInfrastructureError,
	ShopifyE2EPreflightError,
} from "../errors.js";
import {
	CommandSignalError,
	throwIfCommandAborted,
} from "../process/command-signals.js";
import { configuredOriginKey } from "./configured-origin.js";
import { assertProfileName, isValidProfileName } from "./profile-name.js";
import {
	MAX_METADATA_BYTES,
	MAX_STORAGE_STATE_BYTES,
	type PlaywrightStorageState,
	validateParsedStorageState,
	validateStorageState,
} from "./profile-schema.js";

export const EMPTY_STORAGE_STATE: PlaywrightStorageState = Object.freeze({
	cookies: Object.freeze([]),
	origins: Object.freeze([]),
});

export interface SavedProfileSelection {
	readonly kind: "saved";
	readonly name: string;
	readonly role: string;
	readonly state: PlaywrightStorageState;
}

export interface UnauthenticatedProfileSelection {
	readonly kind: "unauthenticated";
	readonly name: string;
	readonly role: string;
	readonly state: PlaywrightStorageState;
}

export type ProfileSelection =
	| SavedProfileSelection
	| UnauthenticatedProfileSelection;

export interface ProfileSummary {
	readonly name: string;
	readonly role: string;
	readonly status: "invalid" | "runnable";
}

export type RunnableProfileSummary =
	| {
			readonly kind: "saved";
			readonly name: string;
			readonly role: string;
	  }
	| {
			readonly kind: "unauthenticated";
			readonly name: string;
			readonly role: string;
	  };

interface OriginMetadata {
	readonly origin: string;
	readonly schemaVersion: 1;
}

interface ProfileMetadata {
	readonly name: string;
	readonly origin: string;
	readonly role: string;
	readonly schemaVersion: 1;
}

interface CreateProfileStoreArgs {
	readonly dataRoot: string;
	readonly origin: string;
	readonly roles: Readonly<Record<string, ShopifyRoleConfig>>;
}

interface CaptureProfileArgs {
	readonly name: string;
	readonly role: string;
	readonly signal?: AbortSignal;
	readonly state: unknown;
}

interface RefreshProfileArgs {
	readonly name: string;
	readonly signal?: AbortSignal;
	readonly state: unknown;
}

interface RemoveProfileArgs {
	readonly name: string;
	readonly signal?: AbortSignal;
}

const cleanupTemporary = async (path: string): Promise<unknown | undefined> => {
	try {
		await rm(path, { force: true, recursive: true });
		return undefined;
	} catch {
		try {
			await rm(path, { force: true, recursive: true });
			return undefined;
		} catch (error) {
			return error;
		}
	}
};

const unavailableRemovalError = (): ShopifyE2EPreflightError =>
	new ShopifyE2EPreflightError("Saved profile is unknown or cannot be removed");

const hasRegularDirectory = async (
	path: string,
	label: string,
): Promise<boolean> => {
	let metadata: Stats;
	try {
		metadata = await lstat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw new ShopifyE2EPreflightError(`${label} is invalid`);
	}
	if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
		throw new ShopifyE2EPreflightError(`${label} is invalid`);
	}
	return true;
};

const assertDirectory = async (path: string, label: string): Promise<void> => {
	if (!(await hasRegularDirectory(path, label))) {
		throw new ShopifyE2EPreflightError(`${label} is invalid`);
	}
};

const readBoundedJson = async (
	path: string,
	limit: number,
): Promise<unknown> => {
	let metadata: Stats;
	try {
		metadata = await lstat(path);
	} catch {
		throw new ShopifyE2EPreflightError("Profile entry is invalid");
	}
	if (
		metadata.isSymbolicLink() ||
		!metadata.isFile() ||
		metadata.size > limit
	) {
		throw new ShopifyE2EPreflightError("Profile entry is invalid");
	}
	try {
		return JSON.parse(await readFile(path, "utf8")) as unknown;
	} catch {
		throw new ShopifyE2EPreflightError("Profile entry is invalid");
	}
};

const isClosedRecord = (
	value: unknown,
	keys: readonly string[],
): value is Record<string, unknown> =>
	typeof value === "object" &&
	value !== null &&
	!Array.isArray(value) &&
	Object.keys(value).length === keys.length &&
	keys.every((key) => Object.hasOwn(value, key));

const parseOriginMetadata = (value: unknown): OriginMetadata => {
	if (
		!isClosedRecord(value, ["schemaVersion", "origin"]) ||
		value.schemaVersion !== 1 ||
		typeof value.origin !== "string"
	) {
		throw new ShopifyE2EPreflightError("Profile origin registry is invalid");
	}
	return value as unknown as OriginMetadata;
};

const parseProfileMetadata = (value: unknown): ProfileMetadata => {
	if (
		!isClosedRecord(value, ["schemaVersion", "name", "role", "origin"]) ||
		value.schemaVersion !== 1 ||
		typeof value.name !== "string" ||
		typeof value.role !== "string" ||
		typeof value.origin !== "string"
	) {
		throw new ShopifyE2EPreflightError("Profile entry is invalid");
	}
	return value as unknown as ProfileMetadata;
};

const writeOwnerOnlyJson = async (
	path: string,
	value: unknown,
	trailingNewline = true,
): Promise<void> => {
	const serialized = JSON.stringify(value);
	await writeFile(path, trailingNewline ? `${serialized}\n` : serialized, {
		flag: "wx",
		mode: 0o600,
	});
	await chmod(path, 0o600);
};

export class ProfileStore {
	readonly #dataRoot: string;
	readonly #origin: string;
	readonly #originDirectory: string;
	readonly #originsDirectory: string;
	readonly #profilesDirectory: string;
	readonly #roles: Readonly<Record<string, ShopifyRoleConfig>>;

	public constructor({ dataRoot, origin, roles }: CreateProfileStoreArgs) {
		this.#dataRoot = dataRoot;
		this.#origin = origin;
		this.#roles = roles;
		this.#originsDirectory = join(dataRoot, "origins");
		this.#originDirectory = join(
			this.#originsDirectory,
			configuredOriginKey(origin),
		);
		this.#profilesDirectory = join(this.#originDirectory, "profiles");
	}

	async #hasOriginPartition(): Promise<boolean> {
		if (!(await hasRegularDirectory(this.#dataRoot, "Profile data directory")))
			return false;
		if (
			!(await hasRegularDirectory(this.#originsDirectory, "Profile registry"))
		)
			return false;
		if (
			!(await hasRegularDirectory(
				this.#originDirectory,
				"Profile origin registry",
			))
		)
			return false;
		const originMetadata = parseOriginMetadata(
			await readBoundedJson(
				join(this.#originDirectory, "origin.json"),
				MAX_METADATA_BYTES,
			),
		);
		if (originMetadata.origin !== this.#origin) {
			throw new ShopifyE2EPreflightError("Profile origin registry is invalid");
		}
		await assertDirectory(this.#profilesDirectory, "Profile registry");
		return true;
	}

	async #readSavedFromExistingPartition(
		name: string,
	): Promise<SavedProfileSelection> {
		const profile = await this.#readProfileMetadata(name);
		this.#assertRunnableProfileMetadata(name, profile);
		const state = await this.#readProfileState(name);
		return { kind: "saved", name, role: profile.role, state };
	}

	async #readProfileMetadata(name: string): Promise<ProfileMetadata> {
		assertProfileName(name);
		const profileDirectory = join(this.#profilesDirectory, name);
		await assertDirectory(profileDirectory, "Saved profile");
		return parseProfileMetadata(
			await readBoundedJson(
				join(profileDirectory, "profile.json"),
				MAX_METADATA_BYTES,
			),
		);
	}

	#assertRunnableProfileMetadata(name: string, profile: ProfileMetadata): void {
		if (
			profile.name !== name ||
			profile.origin !== this.#origin ||
			this.#roles[name]?.authentication === "none" ||
			!isValidProfileName(profile.role) ||
			this.#roles[profile.role]?.authentication !== "required"
		) {
			throw new ShopifyE2EPreflightError("Saved profile is unknown or invalid");
		}
	}

	async #readProfileState(name: string): Promise<PlaywrightStorageState> {
		return validateParsedStorageState(
			await readBoundedJson(
				join(this.#profilesDirectory, name, "storage-state.json"),
				MAX_STORAGE_STATE_BYTES,
			),
		);
	}

	async #readSaved(name: string): Promise<SavedProfileSelection> {
		assertProfileName(name);
		if (!(await this.#hasOriginPartition())) {
			throw new ShopifyE2EPreflightError("Saved profile is unknown or invalid");
		}
		return this.#readSavedFromExistingPartition(name);
	}

	async #prepareRegistryDirectories(): Promise<void> {
		try {
			const createdDataRoot = await mkdir(this.#dataRoot, {
				mode: 0o700,
				recursive: true,
			});
			await assertDirectory(this.#dataRoot, "Profile data directory");
			if (createdDataRoot !== undefined) await chmod(this.#dataRoot, 0o700);
			try {
				await mkdir(this.#originsDirectory, { mode: 0o700 });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
			await assertDirectory(this.#originsDirectory, "Profile registry");
			// `origins` is package-owned even when the caller supplied its parent.
			await chmod(this.#originsDirectory, 0o700);
		} catch (error) {
			if (error instanceof ShopifyE2EPreflightError) throw error;
			throw new ShopifyE2EInfrastructureError(
				"Profile registry could not be prepared",
				{ cause: error },
			);
		}
	}

	public async capture({
		name,
		role,
		signal,
		state,
	}: CaptureProfileArgs): Promise<void> {
		const hasPartition = await this.#assertCaptureNameAvailable(name);
		assertProfileName(role, "Role name");
		if (this.#roles[role]?.authentication !== "required") {
			throw new ShopifyE2EPreflightError(
				"Profile role must be configured with required authentication",
			);
		}
		const validatedState = validateStorageState(state);
		await this.#prepareRegistryDirectories();

		if (!hasPartition) {
			let temporaryOrigin: string | undefined;
			let committed = false;
			try {
				temporaryOrigin = await mkdtemp(
					join(this.#originsDirectory, ".tmp-origin-"),
				);
				await chmod(temporaryOrigin, 0o700);
				await writeOwnerOnlyJson(join(temporaryOrigin, "origin.json"), {
					origin: this.#origin,
					schemaVersion: 1,
				});
				const temporaryProfiles = join(temporaryOrigin, "profiles");
				await mkdir(temporaryProfiles, { mode: 0o700 });
				await this.#writeProfileDirectory(
					join(temporaryProfiles, name),
					name,
					role,
					validatedState,
				);
				if (signal) throwIfCommandAborted(signal);
				await rename(temporaryOrigin, this.#originDirectory);
				committed = true;
				if (signal) throwIfCommandAborted(signal);
			} catch (error) {
				const cleanupError =
					temporaryOrigin === undefined
						? undefined
						: await cleanupTemporary(temporaryOrigin);
				if (committed && error instanceof CommandSignalError) {
					try {
						await rm(this.#originDirectory, { force: true, recursive: true });
					} catch (rollbackError) {
						throw new ShopifyE2EInfrastructureError(
							"Interrupted profile save could not be rolled back safely",
							{ cause: rollbackError },
						);
					}
				}
				if (cleanupError !== undefined) {
					throw new ShopifyE2EInfrastructureError(
						"Profile temporary cleanup could not complete safely",
						{ cause: cleanupError },
					);
				}
				if (
					error instanceof ShopifyE2EPreflightError ||
					error instanceof CommandSignalError
				)
					throw error;
				throw new ShopifyE2EInfrastructureError("Profile could not be saved", {
					cause: error,
				});
			}
			return;
		}

		const target = join(this.#profilesDirectory, name);
		let temporaryProfile: string | undefined;
		let committed = false;
		try {
			temporaryProfile = await mkdtemp(
				join(this.#profilesDirectory, `.tmp-${name}-`),
			);
			await this.#writeProfileDirectoryContents(
				temporaryProfile,
				name,
				role,
				validatedState,
			);
			if (signal) throwIfCommandAborted(signal);
			await rename(temporaryProfile, target);
			committed = true;
			if (signal) throwIfCommandAborted(signal);
		} catch (error) {
			const cleanupError =
				temporaryProfile === undefined
					? undefined
					: await cleanupTemporary(temporaryProfile);
			if (committed && error instanceof CommandSignalError) {
				try {
					await rm(target, { force: true, recursive: true });
				} catch (rollbackError) {
					throw new ShopifyE2EInfrastructureError(
						"Interrupted profile save could not be rolled back safely",
						{ cause: rollbackError },
					);
				}
			}
			if (cleanupError !== undefined) {
				throw new ShopifyE2EInfrastructureError(
					"Profile temporary cleanup could not complete safely",
					{ cause: cleanupError },
				);
			}
			if (
				error instanceof ShopifyE2EPreflightError ||
				error instanceof CommandSignalError
			)
				throw error;
			throw new ShopifyE2EInfrastructureError("Profile could not be saved", {
				cause: error,
			});
		}
	}

	async #assertCaptureNameAvailable(name: string): Promise<boolean> {
		assertProfileName(name);
		if (this.#roles[name]?.authentication === "none") {
			throw new ShopifyE2EPreflightError(
				"Saved profile name must not collide with an unauthenticated role",
			);
		}
		if (!(await this.#hasOriginPartition())) return false;
		try {
			await lstat(join(this.#profilesDirectory, name));
			throw new ShopifyE2EPreflightError("Saved profile already exists");
		} catch (error) {
			if (error instanceof ShopifyE2EPreflightError) throw error;
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				throw new ShopifyE2EPreflightError(
					"Saved profile availability could not be checked",
				);
			}
		}
		return true;
	}

	public async assertCaptureNameAvailable(name: string): Promise<void> {
		await this.#assertCaptureNameAvailable(name);
	}

	async #writeProfileDirectory(
		directory: string,
		name: string,
		role: string,
		state: PlaywrightStorageState,
	): Promise<void> {
		await mkdir(directory, { mode: 0o700 });
		await this.#writeProfileDirectoryContents(directory, name, role, state);
	}

	async #writeProfileDirectoryContents(
		directory: string,
		name: string,
		role: string,
		state: PlaywrightStorageState,
	): Promise<void> {
		await chmod(directory, 0o700);
		await writeOwnerOnlyJson(join(directory, "profile.json"), {
			name,
			origin: this.#origin,
			role,
			schemaVersion: 1,
		});
		await writeOwnerOnlyJson(
			join(directory, "storage-state.json"),
			state,
			false,
		);
	}

	public async refresh({
		name,
		signal,
		state,
	}: RefreshProfileArgs): Promise<void> {
		const profile = await this.#readSaved(name);
		const validatedState = validateStorageState(state);
		const profileDirectory = join(this.#profilesDirectory, profile.name);
		const statePath = join(profileDirectory, "storage-state.json");
		const temporaryState = join(
			profileDirectory,
			`storage-state.json.tmp-${randomUUID()}`,
		);
		const rollbackState = join(
			profileDirectory,
			`storage-state.json.rollback-${randomUUID()}`,
		);
		let replacementCommitted = false;
		let rollbackPrepared = false;
		try {
			const previousBytes = await readFile(statePath);
			const rollbackFile = await open(rollbackState, "wx", 0o600);
			rollbackPrepared = true;
			try {
				await rollbackFile.writeFile(previousBytes);
			} finally {
				await rollbackFile.close();
			}
			await chmod(rollbackState, 0o600);
			await writeOwnerOnlyJson(temporaryState, validatedState, false);
			if (signal) throwIfCommandAborted(signal);
			await rename(temporaryState, statePath);
			replacementCommitted = true;
			if (signal) throwIfCommandAborted(signal);
			await rm(rollbackState, { force: true });
			rollbackPrepared = false;
		} catch (error) {
			const cleanupError = await cleanupTemporary(temporaryState);
			if (replacementCommitted && rollbackPrepared) {
				try {
					await rename(rollbackState, statePath);
					replacementCommitted = false;
					rollbackPrepared = false;
				} catch (rollbackError) {
					throw new ShopifyE2EInfrastructureError(
						"Profile refresh rollback could not complete safely",
						{ cause: rollbackError },
					);
				}
			}
			if (rollbackPrepared) {
				try {
					await rm(rollbackState, { force: true });
				} catch (cleanupError) {
					throw new ShopifyE2EInfrastructureError(
						"Profile refresh cleanup could not complete safely",
						{ cause: cleanupError },
					);
				}
			}
			if (cleanupError !== undefined) {
				throw new ShopifyE2EInfrastructureError(
					"Profile temporary cleanup could not complete safely",
					{ cause: cleanupError },
				);
			}
			if (signal?.aborted) throwIfCommandAborted(signal);
			if (error instanceof CommandSignalError) throw error;
			throw new ShopifyE2EInfrastructureError(
				"Profile refresh could not be saved; the previous state is unchanged",
				{ cause: error },
			);
		}
	}

	public async resolve(name: string): Promise<ProfileSelection> {
		assertProfileName(name);
		if (this.#roles[name]?.authentication === "none") {
			return {
				kind: "unauthenticated",
				name,
				role: name,
				state: EMPTY_STORAGE_STATE,
			};
		}
		return this.#readSaved(name);
	}

	#assertRemovableName(name: string): void {
		assertProfileName(name);
		if (this.#roles[name]?.authentication === "none") {
			throw unavailableRemovalError();
		}
	}

	async #assertRemovableTarget(name: string): Promise<string> {
		const path = join(this.#profilesDirectory, name);
		let metadata: Stats;
		try {
			metadata = await lstat(path);
		} catch {
			throw unavailableRemovalError();
		}
		if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
			throw unavailableRemovalError();
		}
		return path;
	}

	public async removableProfiles(): Promise<readonly string[]> {
		if (!(await this.#hasOriginPartition())) return [];
		const entries = await readdir(this.#profilesDirectory, {
			withFileTypes: true,
		});
		return entries
			.filter(
				(entry) =>
					!entry.name.startsWith(".tmp-") &&
					isValidProfileName(entry.name) &&
					entry.isDirectory() &&
					this.#roles[entry.name]?.authentication !== "none",
			)
			.map((entry) => entry.name)
			.sort((left, right) => left.localeCompare(right));
	}

	public async remove({ name, signal }: RemoveProfileArgs): Promise<void> {
		this.#assertRemovableName(name);
		if (!(await this.#hasOriginPartition())) {
			throw unavailableRemovalError();
		}
		const target = await this.#assertRemovableTarget(name);

		let quarantine: string | undefined;
		let committed = false;
		try {
			quarantine = await mkdtemp(
				join(this.#profilesDirectory, `.tmp-remove-${name}-`),
			);
			await chmod(quarantine, 0o700);
			await this.#assertRemovableTarget(name);
			if (signal) throwIfCommandAborted(signal);
			await rename(target, join(quarantine, "profile"));
			committed = true;
			await rm(quarantine, {
				force: true,
				maxRetries: 2,
				recursive: true,
				retryDelay: 100,
			});
		} catch (error) {
			if (committed) {
				throw new ShopifyE2EInfrastructureError(
					"Saved profile is unavailable, but local secret cleanup is incomplete",
					{ cause: error },
				);
			}
			if (quarantine !== undefined) {
				try {
					await rm(quarantine, { force: true, recursive: true });
				} catch (cleanupError) {
					throw new ShopifyE2EInfrastructureError(
						"Profile removal preparation could not be cleaned; no saved profile changed",
						{ cause: cleanupError },
					);
				}
			}
			if (
				error instanceof ShopifyE2EPreflightError ||
				error instanceof CommandSignalError
			) {
				throw error;
			}
			throw new ShopifyE2EInfrastructureError(
				"Profile could not be removed; no saved profile changed",
				{ cause: error },
			);
		}
	}

	async #scanSavedProfiles(): Promise<readonly ProfileSummary[]> {
		if (!(await this.#hasOriginPartition())) return [];
		const entries = await readdir(this.#profilesDirectory, {
			withFileTypes: true,
		});
		const summaries: ProfileSummary[] = [];
		for (const entry of entries) {
			if (entry.name.startsWith(".tmp-")) continue;
			const safeName = isValidProfileName(entry.name)
				? entry.name
				: "<invalid-name>";
			if (!entry.isDirectory() || !isValidProfileName(entry.name)) {
				summaries.push({ name: safeName, role: "unknown", status: "invalid" });
				continue;
			}
			let safeRole = "unknown";
			try {
				const profile = await this.#readProfileMetadata(entry.name);
				if (isValidProfileName(profile.role)) safeRole = profile.role;
				this.#assertRunnableProfileMetadata(entry.name, profile);
				await this.#readProfileState(entry.name);
				summaries.push({
					name: entry.name,
					role: profile.role,
					status: "runnable",
				});
			} catch {
				summaries.push({ name: safeName, role: safeRole, status: "invalid" });
			}
		}
		return summaries.sort((left, right) =>
			`${left.name}\0${left.role}`.localeCompare(
				`${right.name}\0${right.role}`,
			),
		);
	}

	public async list(): Promise<readonly ProfileSummary[]> {
		return this.#scanSavedProfiles();
	}

	public async runnableProfiles(): Promise<readonly RunnableProfileSummary[]> {
		const profiles: RunnableProfileSummary[] = Object.entries(this.#roles)
			.filter(([, role]) => role.authentication === "none")
			.map(([role]) => ({
				kind: "unauthenticated",
				name: role,
				role,
			}));
		for (const summary of await this.#scanSavedProfiles()) {
			if (summary.status === "runnable") {
				profiles.push({
					kind: "saved",
					name: summary.name,
					role: summary.role,
				});
			}
		}
		return profiles.sort((left, right) => left.name.localeCompare(right.name));
	}
}

export const createProfileStore = (
	args: CreateProfileStoreArgs,
): ProfileStore => new ProfileStore(args);
