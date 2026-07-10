import { randomUUID } from "node:crypto";
import {
	chmod,
	mkdir,
	readFile,
	rename as renameFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import type { BrowserContext } from "playwright-core";
import { isRecord } from "./guards.js";
import type { ResolvedShopifyAuthProfile } from "./shopify-e2e-config.js";

type PlaywrightStorageState = Awaited<
	ReturnType<BrowserContext["storageState"]>
>;

export type ShopifyStorageState = Omit<PlaywrightStorageState, "origins"> & {
	origins: Array<
		PlaywrightStorageState["origins"][number] & {
			indexedDB?: unknown[];
		}
	>;
};

export interface SaveAuthProfileOptions {
	platform?: NodeJS.Platform;
	rename?: typeof renameFile;
	warn?: (message: string) => void;
}

export function emptyShopifyStorageState(): ShopifyStorageState {
	return { cookies: [], origins: [] };
}

export async function loadAuthProfile(
	profile: ResolvedShopifyAuthProfile,
): Promise<ShopifyStorageState> {
	const storageState = await readAuthProfile(profile);

	if (!storageState) {
		throw new Error(
			`Shopify auth profile ${JSON.stringify(profile.name)} was not found at ${profile.storageStatePath}.`,
		);
	}

	return storageState;
}

export async function loadCaptureTargetAuthProfile(
	profile: ResolvedShopifyAuthProfile,
): Promise<ShopifyStorageState | undefined> {
	return readAuthProfile(profile);
}

async function readAuthProfile(
	profile: ResolvedShopifyAuthProfile,
): Promise<ShopifyStorageState | undefined> {
	let contents: string;

	try {
		contents = await readFile(profile.storageStatePath, "utf8");
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			return undefined;
		}

		throw new Error(
			`Could not read Shopify auth profile ${JSON.stringify(profile.name)} at ${profile.storageStatePath}.`,
			{ cause: error },
		);
	}

	let value: unknown;

	try {
		value = JSON.parse(contents) as unknown;
	} catch (error) {
		throw new Error(
			`Invalid Shopify auth profile ${JSON.stringify(profile.name)} at ${profile.storageStatePath}: could not parse JSON.`,
			{ cause: error },
		);
	}

	if (!isShopifyStorageState(value)) {
		throw new Error(
			`Invalid Shopify auth profile ${JSON.stringify(profile.name)} at ${profile.storageStatePath}: expected Playwright storage state.`,
		);
	}

	return value;
}

export async function saveAuthProfile(
	profile: ResolvedShopifyAuthProfile,
	storageState: ShopifyStorageState,
	options: SaveAuthProfileOptions = {},
): Promise<{ path: string; profile: ResolvedShopifyAuthProfile }> {
	const directory = dirname(profile.storageStatePath);
	const temporaryPath = join(
		directory,
		`.${profile.name}.${randomUUID()}.tmp`,
	);
	const platform = options.platform ?? process.platform;
	const rename = options.rename ?? renameFile;

	try {
		await mkdir(directory, { mode: 0o700, recursive: true });

		if (platform === "win32") {
			options.warn?.(
				`Could not enforce POSIX permissions for Shopify auth profile ${JSON.stringify(profile.name)} at ${profile.storageStatePath} on ${platform}. Protect this bearer file with local filesystem permissions.`,
			);
		} else {
			await chmod(directory, 0o700);
		}

		await writeFile(temporaryPath, `${JSON.stringify(storageState)}\n`, {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
		});

		if (platform !== "win32") {
			await chmod(temporaryPath, 0o600);
		}

		await rename(temporaryPath, profile.storageStatePath);

		return { path: profile.storageStatePath, profile };
	} catch (error) {
		throw new Error(
			`Could not save Shopify auth profile ${JSON.stringify(profile.name)} at ${profile.storageStatePath}.`,
			{ cause: error },
		);
	} finally {
		await rm(temporaryPath, { force: true }).catch(() => undefined);
	}
}

function isShopifyStorageState(value: unknown): value is ShopifyStorageState {
	return (
		isRecord(value) &&
		Array.isArray(value.cookies) &&
		value.cookies.every(isStorageCookie) &&
		Array.isArray(value.origins) &&
		value.origins.every(isStorageOrigin)
	);
}

function isStorageCookie(value: unknown): boolean {
	return (
		isRecord(value) &&
		typeof value.name === "string" &&
		typeof value.value === "string" &&
		typeof value.domain === "string" &&
		typeof value.path === "string" &&
		typeof value.expires === "number" &&
		typeof value.httpOnly === "boolean" &&
		typeof value.secure === "boolean" &&
		["Strict", "Lax", "None"].includes(String(value.sameSite))
	);
}

function isStorageOrigin(value: unknown): boolean {
	return (
		isRecord(value) &&
		typeof value.origin === "string" &&
		Array.isArray(value.localStorage) &&
		value.localStorage.every(isStorageEntry) &&
		(value.indexedDB === undefined || Array.isArray(value.indexedDB))
	);
}

function isStorageEntry(value: unknown): boolean {
	return (
		isRecord(value) &&
		typeof value.name === "string" &&
		typeof value.value === "string"
	);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
