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

import {
	ShopifyE2EInfrastructureError,
	ShopifyE2EPreflightError,
} from "../errors.js";
import {
	CommandSignalError,
	throwIfCommandAborted,
} from "../process/command-signals.js";
import {
	assertRoleName,
	isValidRoleName,
	validateRoleList,
} from "../roles/role-name.cjs";
import {
	MAX_STORAGE_STATE_BYTES,
	type PlaywrightStorageState,
	validateParsedStorageState,
	validateStorageState,
} from "../storage-state/schema.cjs";
import { configuredOriginKey } from "./configured-origin.cjs";

const MAX_METADATA_BYTES = 16 * 1024;

export interface RoleStateSelection {
	readonly role: string;
	readonly state: PlaywrightStorageState;
}

export type RoleStateStatus = "invalid" | "missing" | "orphaned" | "ready";

export interface RoleStateSummary {
	readonly role: string;
	readonly status: RoleStateStatus;
}

interface OriginMetadata {
	readonly origin: string;
	readonly schemaVersion: 1;
}

interface RoleStateMetadata {
	readonly origin: string;
	readonly role: string;
	readonly schemaVersion: 1;
}

export interface CreateRoleStateStoreArgs {
	readonly dataRoot: string;
	readonly origin: string;
	readonly roles: readonly string[];
}

export interface CaptureRoleStateArgs {
	readonly role: string;
	readonly signal?: AbortSignal;
	readonly state: unknown;
}

export interface RemoveRoleStateArgs {
	readonly role: string;
	readonly signal?: AbortSignal;
}

interface PartitionStatus {
	readonly originExists: boolean;
	readonly registryExists: boolean;
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

const isMissing = (error: unknown): boolean =>
	(error as NodeJS.ErrnoException).code === "ENOENT";

const regularDirectoryExists = async (
	path: string,
	label: string,
): Promise<boolean> => {
	let metadata: Stats;
	try {
		metadata = await lstat(path);
	} catch (error) {
		if (isMissing(error)) return false;
		throw new ShopifyE2EPreflightError(`${label} is invalid`);
	}
	if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
		throw new ShopifyE2EPreflightError(`${label} is invalid`);
	}
	return true;
};

const assertRegularDirectory = async (
	path: string,
	label: string,
): Promise<void> => {
	if (!(await regularDirectoryExists(path, label))) {
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
		throw new ShopifyE2EPreflightError("Role state entry is invalid");
	}
	if (
		metadata.isSymbolicLink() ||
		!metadata.isFile() ||
		metadata.size > limit
	) {
		throw new ShopifyE2EPreflightError("Role state entry is invalid");
	}
	try {
		return JSON.parse(await readFile(path, "utf8")) as unknown;
	} catch {
		throw new ShopifyE2EPreflightError("Role state entry is invalid");
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
		throw new ShopifyE2EPreflightError("Role state origin registry is invalid");
	}
	return value as unknown as OriginMetadata;
};

const parseRoleStateMetadata = (value: unknown): RoleStateMetadata => {
	if (
		!isClosedRecord(value, ["schemaVersion", "role", "origin"]) ||
		value.schemaVersion !== 1 ||
		typeof value.role !== "string" ||
		typeof value.origin !== "string"
	) {
		throw new ShopifyE2EPreflightError("Role state entry is invalid");
	}
	return value as unknown as RoleStateMetadata;
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

const unavailableRemovalError = (): ShopifyE2EPreflightError =>
	new ShopifyE2EPreflightError("Role state is unknown or cannot be removed");

const unsafeCollisionError = (): ShopifyE2EPreflightError =>
	new ShopifyE2EPreflightError(
		"Role state has an unsafe filesystem collision and requires manual cleanup",
	);

const validateRoleState = (value: unknown): PlaywrightStorageState => {
	try {
		return validateStorageState(value);
	} catch (cause) {
		throw new ShopifyE2EPreflightError("Role state is invalid", { cause });
	}
};

const validateStoredRoleState = (value: unknown): PlaywrightStorageState => {
	try {
		return validateParsedStorageState(value);
	} catch (cause) {
		throw new ShopifyE2EPreflightError("Role state entry is invalid", {
			cause,
		});
	}
};

export class RoleStateStore {
	readonly #dataRoot: string;
	readonly #origin: string;
	readonly #originDirectory: string;
	readonly #originsDirectory: string;
	readonly #roleSet: ReadonlySet<string>;
	readonly #roles: readonly string[];
	readonly #statesDirectory: string;

	public constructor({ dataRoot, origin, roles }: CreateRoleStateStoreArgs) {
		const validatedRoles = validateRoleList(roles);
		this.#dataRoot = dataRoot;
		this.#origin = origin;
		this.#roles = validatedRoles;
		this.#roleSet = new Set(validatedRoles);
		this.#originsDirectory = join(dataRoot, "origins");
		this.#originDirectory = join(
			this.#originsDirectory,
			configuredOriginKey(origin),
		);
		this.#statesDirectory = join(this.#originDirectory, "role-states");
	}

	#assertConfiguredRole(role: string): void {
		assertRoleName(role);
		if (!this.#roleSet.has(role)) {
			throw new ShopifyE2EPreflightError("Role is not configured");
		}
	}

	async #partitionStatus(): Promise<PartitionStatus> {
		if (
			!(await regularDirectoryExists(
				this.#dataRoot,
				"Role state data directory",
			))
		) {
			return { originExists: false, registryExists: false };
		}
		if (
			!(await regularDirectoryExists(
				this.#originsDirectory,
				"Role state registry",
			))
		) {
			return { originExists: false, registryExists: false };
		}
		if (
			!(await regularDirectoryExists(
				this.#originDirectory,
				"Role state origin registry",
			))
		) {
			return { originExists: false, registryExists: false };
		}
		const originMetadata = parseOriginMetadata(
			await readBoundedJson(
				join(this.#originDirectory, "origin.json"),
				MAX_METADATA_BYTES,
			),
		);
		if (originMetadata.origin !== this.#origin) {
			throw new ShopifyE2EPreflightError(
				"Role state origin registry is invalid",
			);
		}
		const registryExists = await regularDirectoryExists(
			this.#statesDirectory,
			"Role state registry",
		);
		return { originExists: true, registryExists };
	}

	async #prepareRegistryDirectories(): Promise<void> {
		try {
			const createdDataRoot = await mkdir(this.#dataRoot, {
				mode: 0o700,
				recursive: true,
			});
			await assertRegularDirectory(this.#dataRoot, "Role state data directory");
			if (createdDataRoot !== undefined) await chmod(this.#dataRoot, 0o700);
			try {
				await mkdir(this.#originsDirectory, { mode: 0o700 });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
			await assertRegularDirectory(
				this.#originsDirectory,
				"Role state registry",
			);
			await chmod(this.#originsDirectory, 0o700);
		} catch (error) {
			if (error instanceof ShopifyE2EPreflightError) throw error;
			throw new ShopifyE2EInfrastructureError(
				"Role state registry could not be prepared",
				{ cause: error },
			);
		}
	}

	async #prepareExistingOriginRegistry(): Promise<void> {
		try {
			try {
				await mkdir(this.#statesDirectory, { mode: 0o700 });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
			await assertRegularDirectory(
				this.#statesDirectory,
				"Role state registry",
			);
			await chmod(this.#statesDirectory, 0o700);
		} catch (error) {
			if (error instanceof ShopifyE2EPreflightError) throw error;
			throw new ShopifyE2EInfrastructureError(
				"Role state registry could not be prepared",
				{ cause: error },
			);
		}
	}

	async #writeRoleDirectory(
		directory: string,
		role: string,
		state: PlaywrightStorageState,
	): Promise<void> {
		await mkdir(directory, { mode: 0o700 });
		await this.#writeRoleDirectoryContents(directory, role, state);
	}

	async #writeRoleDirectoryContents(
		directory: string,
		role: string,
		state: PlaywrightStorageState,
	): Promise<void> {
		await chmod(directory, 0o700);
		await writeOwnerOnlyJson(join(directory, "role-state.json"), {
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

	async #readReadyFromExistingRegistry(
		role: string,
	): Promise<RoleStateSelection> {
		const directory = join(this.#statesDirectory, role);
		await assertRegularDirectory(directory, "Role state");
		const metadata = parseRoleStateMetadata(
			await readBoundedJson(
				join(directory, "role-state.json"),
				MAX_METADATA_BYTES,
			),
		);
		if (metadata.role !== role || metadata.origin !== this.#origin) {
			throw new ShopifyE2EPreflightError("Role state is invalid");
		}
		const state = validateStoredRoleState(
			await readBoundedJson(
				join(directory, "storage-state.json"),
				MAX_STORAGE_STATE_BYTES,
			),
		);
		return { role, state };
	}

	public async resolve(role: string): Promise<RoleStateSelection> {
		this.#assertConfiguredRole(role);
		const partition = await this.#partitionStatus();
		if (!partition.registryExists) {
			throw new ShopifyE2EPreflightError("Role state is missing or invalid");
		}
		const metadata = await this.#entryMetadata(role);
		if (metadata === undefined) {
			throw new ShopifyE2EPreflightError("Role state is missing or invalid");
		}
		if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
			throw unsafeCollisionError();
		}
		try {
			return await this.#readReadyFromExistingRegistry(role);
		} catch (error) {
			if (error instanceof ShopifyE2EPreflightError) {
				throw new ShopifyE2EPreflightError("Role state is missing or invalid", {
					cause: error,
				});
			}
			throw error;
		}
	}

	public async assertCaptureAvailable(role: string): Promise<void> {
		this.#assertConfiguredRole(role);
		const partition = await this.#partitionStatus();
		if (!partition.registryExists) return;
		try {
			const metadata = await lstat(join(this.#statesDirectory, role));
			if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
				throw unsafeCollisionError();
			}
			throw new ShopifyE2EPreflightError("Role state already exists");
		} catch (error) {
			if (error instanceof ShopifyE2EPreflightError) throw error;
			if (!isMissing(error)) {
				throw new ShopifyE2EPreflightError(
					"Role state availability could not be checked",
				);
			}
		}
	}

	public async capture({
		role,
		signal,
		state,
	}: CaptureRoleStateArgs): Promise<void> {
		await this.assertCaptureAvailable(role);
		const validatedState = validateRoleState(state);
		await this.#prepareRegistryDirectories();
		const partition = await this.#partitionStatus();

		if (!partition.originExists) {
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
				const temporaryStates = join(temporaryOrigin, "role-states");
				await mkdir(temporaryStates, { mode: 0o700 });
				await this.#writeRoleDirectory(
					join(temporaryStates, role),
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
						await rm(this.#originDirectory, {
							force: true,
							recursive: true,
						});
					} catch (rollbackError) {
						throw new ShopifyE2EInfrastructureError(
							"Interrupted role state save could not be rolled back safely",
							{ cause: rollbackError },
						);
					}
				}
				if (cleanupError !== undefined) {
					throw new ShopifyE2EInfrastructureError(
						"Role state temporary cleanup could not complete safely",
						{ cause: cleanupError },
					);
				}
				if (
					error instanceof ShopifyE2EPreflightError ||
					error instanceof CommandSignalError
				) {
					throw error;
				}
				throw new ShopifyE2EInfrastructureError(
					"Role state could not be saved",
					{ cause: error },
				);
			}
			return;
		}

		if (!partition.registryExists) {
			await this.#prepareExistingOriginRegistry();
		}
		const target = join(this.#statesDirectory, role);
		let temporaryRole: string | undefined;
		let committed = false;
		try {
			temporaryRole = await mkdtemp(
				join(this.#statesDirectory, `.tmp-${role}-`),
			);
			await this.#writeRoleDirectoryContents(
				temporaryRole,
				role,
				validatedState,
			);
			if (signal) throwIfCommandAborted(signal);
			await rename(temporaryRole, target);
			committed = true;
			if (signal) throwIfCommandAborted(signal);
		} catch (error) {
			const cleanupError =
				temporaryRole === undefined
					? undefined
					: await cleanupTemporary(temporaryRole);
			if (committed && error instanceof CommandSignalError) {
				try {
					await rm(target, { force: true, recursive: true });
				} catch (rollbackError) {
					throw new ShopifyE2EInfrastructureError(
						"Interrupted role state save could not be rolled back safely",
						{ cause: rollbackError },
					);
				}
			}
			if (cleanupError !== undefined) {
				throw new ShopifyE2EInfrastructureError(
					"Role state temporary cleanup could not complete safely",
					{ cause: cleanupError },
				);
			}
			if (
				error instanceof ShopifyE2EPreflightError ||
				error instanceof CommandSignalError
			) {
				throw error;
			}
			throw new ShopifyE2EInfrastructureError("Role state could not be saved", {
				cause: error,
			});
		}
	}

	public async refresh({
		role,
		signal,
		state,
	}: CaptureRoleStateArgs): Promise<void> {
		const selected = await this.resolve(role);
		const validatedState = validateRoleState(state);
		const roleDirectory = join(this.#statesDirectory, selected.role);
		const statePath = join(roleDirectory, "storage-state.json");
		const temporaryState = join(
			roleDirectory,
			`storage-state.json.tmp-${randomUUID()}`,
		);
		const rollbackState = join(
			roleDirectory,
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
					rollbackPrepared = false;
				} catch (rollbackError) {
					throw new ShopifyE2EInfrastructureError(
						"Role state refresh rollback could not complete safely",
						{ cause: rollbackError },
					);
				}
			}
			if (rollbackPrepared) {
				try {
					await rm(rollbackState, { force: true });
				} catch (rollbackCleanupError) {
					throw new ShopifyE2EInfrastructureError(
						"Role state refresh cleanup could not complete safely",
						{ cause: rollbackCleanupError },
					);
				}
			}
			if (cleanupError !== undefined) {
				throw new ShopifyE2EInfrastructureError(
					"Role state temporary cleanup could not complete safely",
					{ cause: cleanupError },
				);
			}
			if (signal?.aborted) throwIfCommandAborted(signal);
			if (error instanceof CommandSignalError) throw error;
			throw new ShopifyE2EInfrastructureError(
				"Role state refresh could not be saved; the previous state is unchanged",
				{ cause: error },
			);
		}
	}

	async #entryMetadata(role: string): Promise<Stats | undefined> {
		try {
			return await lstat(join(this.#statesDirectory, role));
		} catch (error) {
			if (isMissing(error)) return undefined;
			throw new ShopifyE2EInfrastructureError(
				"Role state could not be inspected",
				{ cause: error },
			);
		}
	}

	public async list(): Promise<readonly RoleStateSummary[]> {
		const partition = await this.#partitionStatus();
		const summaries: RoleStateSummary[] = [];
		for (const role of [...this.#roles].sort((left, right) =>
			left.localeCompare(right),
		)) {
			if (!partition.registryExists) {
				summaries.push({ role, status: "missing" });
				continue;
			}
			const metadata = await this.#entryMetadata(role);
			if (metadata === undefined) {
				summaries.push({ role, status: "missing" });
				continue;
			}
			if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
				summaries.push({ role, status: "invalid" });
				continue;
			}
			try {
				await this.#readReadyFromExistingRegistry(role);
				summaries.push({ role, status: "ready" });
			} catch {
				summaries.push({ role, status: "invalid" });
			}
		}

		if (partition.registryExists) {
			const entries = await readdir(this.#statesDirectory, {
				withFileTypes: true,
			});
			for (const entry of entries) {
				if (
					entry.name.startsWith(".tmp-") ||
					!isValidRoleName(entry.name) ||
					this.#roleSet.has(entry.name) ||
					!entry.isDirectory()
				) {
					continue;
				}
				summaries.push({ role: entry.name, status: "orphaned" });
			}
		}
		return summaries.sort((left, right) => left.role.localeCompare(right.role));
	}

	public async removableRoles(): Promise<readonly string[]> {
		const partition = await this.#partitionStatus();
		if (!partition.registryExists) return [];
		const entries = await readdir(this.#statesDirectory);
		const removable: string[] = [];
		for (const role of entries) {
			if (role.startsWith(".tmp-") || !isValidRoleName(role)) continue;
			const metadata = await this.#entryMetadata(role);
			if (
				metadata !== undefined &&
				!metadata.isSymbolicLink() &&
				metadata.isDirectory()
			) {
				removable.push(role);
			}
		}
		return removable.sort((left, right) => left.localeCompare(right));
	}

	async #assertRemovableTarget(role: string): Promise<string> {
		assertRoleName(role);
		const target = join(this.#statesDirectory, role);
		let exactNameExists: boolean;
		try {
			exactNameExists = (await readdir(this.#statesDirectory)).some(
				(entry) => entry === role,
			);
		} catch (error) {
			if (isMissing(error)) throw unavailableRemovalError();
			throw new ShopifyE2EInfrastructureError(
				"Role state could not be inspected; no role state changed",
				{ cause: error },
			);
		}
		if (!exactNameExists) throw unavailableRemovalError();

		let metadata: Stats;
		try {
			metadata = await lstat(target);
		} catch (error) {
			if (isMissing(error)) throw unavailableRemovalError();
			throw new ShopifyE2EInfrastructureError(
				"Role state could not be inspected; no role state changed",
				{ cause: error },
			);
		}
		if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
			throw unsafeCollisionError();
		}
		return target;
	}

	public async remove({ role, signal }: RemoveRoleStateArgs): Promise<void> {
		assertRoleName(role);
		const partition = await this.#partitionStatus();
		if (!partition.registryExists) throw unavailableRemovalError();
		const target = await this.#assertRemovableTarget(role);
		let quarantine: string | undefined;
		let committed = false;
		try {
			quarantine = await mkdtemp(
				join(this.#statesDirectory, `.tmp-remove-${role}-`),
			);
			await chmod(quarantine, 0o700);
			await this.#assertRemovableTarget(role);
			if (signal) throwIfCommandAborted(signal);
			await rename(target, join(quarantine, "role-state"));
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
					"Role state is unavailable, but local secret cleanup is incomplete",
					{ cause: error },
				);
			}
			if (quarantine !== undefined) {
				try {
					await rm(quarantine, { force: true, recursive: true });
				} catch (cleanupError) {
					throw new ShopifyE2EInfrastructureError(
						"Role state removal preparation could not be cleaned; no role state changed",
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
				"Role state could not be removed; no role state changed",
				{ cause: error },
			);
		}
	}
}

export const createRoleStateStore = (
	args: CreateRoleStateStoreArgs,
): RoleStateStore => new RoleStateStore(args);
