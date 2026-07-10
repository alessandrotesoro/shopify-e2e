import { constants } from "node:fs";
import {
	access,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
	loadAuthProfile,
	loadCaptureTargetAuthProfile,
	type ShopifyStorageState,
	saveAuthProfile,
} from "../src/auth-profile.js";
import type { ResolvedShopifyAuthProfile } from "../src/shopify-e2e-config.js";

function profile(
	directory: string,
	name = "customer-a",
): ResolvedShopifyAuthProfile {
	return {
		name,
		storageStatePath: join(directory, "profiles", `${name}.json`),
	};
}

const storageState: ShopifyStorageState = {
	cookies: [],
	origins: [
		{
			indexedDB: [{ name: "shopify-auth", stores: [] }],
			localStorage: [{ name: "customer", value: "a" }],
			origin: "https://shop.app",
		},
	],
};

describe("auth profiles", () => {
	it("allows a missing profile only when the caller is creating it", async () => {
		const directory = await mkdtemp(join(tmpdir(), "shopify-profile-"));
		const selectedProfile = profile(directory);

		await expect(
			loadCaptureTargetAuthProfile(selectedProfile),
		).resolves.toBeUndefined();
		await expect(loadAuthProfile(selectedProfile)).rejects.toThrow(
			`Shopify auth profile "customer-a" was not found at ${selectedProfile.storageStatePath}.`,
		);
	});

	it("loads a valid profile without dropping IndexedDB state", async () => {
		const directory = await mkdtemp(join(tmpdir(), "shopify-profile-"));
		const selectedProfile = profile(directory);
		await saveAuthProfile(selectedProfile, storageState);

		await expect(loadAuthProfile(selectedProfile)).resolves.toEqual(
			storageState,
		);
	});

	it("rejects malformed JSON with pseudonymous profile context", async () => {
		const directory = await mkdtemp(join(tmpdir(), "shopify-profile-"));
		const selectedProfile = profile(directory);
		await saveRawProfile(selectedProfile, "{not-json");

		await expect(loadAuthProfile(selectedProfile)).rejects.toThrow(
			`Invalid Shopify auth profile "customer-a" at ${selectedProfile.storageStatePath}: could not parse JSON.`,
		);
	});

	it("rejects malformed storage state without falling back", async () => {
		const directory = await mkdtemp(join(tmpdir(), "shopify-profile-"));
		const selectedProfile = profile(directory);
		await saveRawProfile(
			selectedProfile,
			JSON.stringify({ cookies: [], origins: [{ origin: 42 }] }),
		);

		await expect(loadAuthProfile(selectedProfile)).rejects.toThrow(
			`Invalid Shopify auth profile "customer-a" at ${selectedProfile.storageStatePath}: expected Playwright storage state.`,
		);
	});

	it.runIf(process.platform !== "win32")(
		"creates restricted destination directories and files",
		async () => {
			const directory = await mkdtemp(join(tmpdir(), "shopify-profile-"));
			const selectedProfile = profile(directory);

			await saveAuthProfile(selectedProfile, storageState);

			expect(
				JSON.parse(
					await readFile(selectedProfile.storageStatePath, "utf8"),
				),
			).toEqual(storageState);
			expect((await stat(join(directory, "profiles"))).mode & 0o777).toBe(
				0o700,
			);
			expect(
				(await stat(selectedProfile.storageStatePath)).mode & 0o777,
			).toBe(0o600);
			expect(await readdir(join(directory, "profiles"))).toEqual([
				"customer-a.json",
			]);
		},
	);

	it("atomically replaces only the selected profile", async () => {
		const directory = await mkdtemp(join(tmpdir(), "shopify-profile-"));
		const selectedProfile = profile(directory);
		const otherProfile = profile(directory, "customer-b");
		const previous = JSON.stringify({ cookies: [], origins: [] });
		await saveRawProfile(selectedProfile, previous);
		await saveRawProfile(otherProfile, previous);

		await saveAuthProfile(selectedProfile, storageState);

		expect(
			JSON.parse(
				await readFile(selectedProfile.storageStatePath, "utf8"),
			),
		).toEqual(storageState);
		expect(await readFile(otherProfile.storageStatePath, "utf8")).toBe(
			previous,
		);
		expect((await readdir(join(directory, "profiles"))).sort()).toEqual([
			"customer-a.json",
			"customer-b.json",
		]);
	});

	it("preserves the previous profile and removes its temporary file when replacement fails", async () => {
		const directory = await mkdtemp(join(tmpdir(), "shopify-profile-"));
		const selectedProfile = profile(directory);
		const previous = JSON.stringify({ cookies: [], origins: [] });
		await saveRawProfile(selectedProfile, previous);

		await expect(
			saveAuthProfile(selectedProfile, storageState, {
				rename: async () => {
					throw new Error("rename denied");
				},
			}),
		).rejects.toThrow(
			`Could not save Shopify auth profile "customer-a" at ${selectedProfile.storageStatePath}.`,
		);
		expect(await readFile(selectedProfile.storageStatePath, "utf8")).toBe(
			previous,
		);
		expect(await readdir(join(directory, "profiles"))).toEqual([
			"customer-a.json",
		]);
	});

	it("warns when restrictive POSIX permissions are unavailable", async () => {
		const directory = await mkdtemp(join(tmpdir(), "shopify-profile-"));
		const selectedProfile = profile(directory);
		const warn = vi.fn();

		await saveAuthProfile(selectedProfile, storageState, {
			platform: "win32",
			warn,
		});

		expect(warn).toHaveBeenCalledWith(
			`Could not enforce POSIX permissions for Shopify auth profile "customer-a" at ${selectedProfile.storageStatePath} on win32. Protect this bearer file with local filesystem permissions.`,
		);
		await expect(
			access(selectedProfile.storageStatePath, constants.F_OK),
		).resolves.toBeUndefined();
	});
});

async function saveRawProfile(
	selectedProfile: ResolvedShopifyAuthProfile,
	contents: string,
): Promise<void> {
	const directory = dirname(selectedProfile.storageStatePath);
	await mkdir(directory, { recursive: true });
	await writeFile(selectedProfile.storageStatePath, contents, "utf8");
}
