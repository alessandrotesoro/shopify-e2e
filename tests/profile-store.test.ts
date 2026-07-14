import {
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	stat,
	symlink,
	truncate,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandSignalError } from "../src/process/command-signals.js";
import { configuredOriginKey } from "../src/profiles/configured-origin.js";
import {
	MAX_METADATA_BYTES,
	MAX_STORAGE_STATE_BYTES,
} from "../src/profiles/profile-schema.js";
import {
	createProfileStore,
	EMPTY_STORAGE_STATE,
} from "../src/profiles/profile-store.js";

const temporaryDirectories: string[] = [];

const makeRoot = async (): Promise<string> => {
	const root = await mkdtemp(join(tmpdir(), "shopify-e2e-profiles-"));
	temporaryDirectories.push(root);
	return realpath(root);
};

const roles = {
	admin: { authentication: "required" as const },
	guest: { authentication: "none" as const },
};

const configuredOrigin = "https://shop.example";

const profilePaths = (
	dataRoot: string,
	name = "admin-primary",
	origin = configuredOrigin,
) => {
	const originDirectory = join(
		dataRoot,
		"origins",
		configuredOriginKey(origin),
	);
	const profileDirectory = join(originDirectory, "profiles", name);
	return {
		originDirectory,
		originMetadata: join(originDirectory, "origin.json"),
		profileDirectory,
		profileMetadata: join(profileDirectory, "profile.json"),
		profilesDirectory: join(originDirectory, "profiles"),
		state: join(profileDirectory, "storage-state.json"),
	};
};

const stateWithCookie = (value: string) => ({
	cookies: [
		{
			domain: "shop.example",
			expires: -1,
			httpOnly: true,
			name: "session",
			path: "/",
			sameSite: "Lax" as const,
			secure: true,
			value,
		},
	],
	origins: [],
});

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

describe("profile store", () => {
	it("atomically creates, lists, resolves, and refreshes a profile", async () => {
		const dataRoot = join(await makeRoot(), "data");
		const origin = "https://shop.example";
		const store = createProfileStore({ dataRoot, origin, roles });
		const initial = {
			cookies: [
				{
					domain: "shop.example",
					expires: -1,
					httpOnly: true,
					name: "session",
					path: "/",
					sameSite: "Lax" as const,
					secure: true,
					value: "secret",
				},
			],
			origins: [],
		};

		await store.capture({
			name: "admin-primary",
			role: "admin",
			state: initial,
		});
		expect(await store.list()).toEqual([
			{ name: "admin-primary", role: "admin", status: "runnable" },
		]);
		expect(await store.resolve("admin-primary")).toEqual({
			kind: "saved",
			name: "admin-primary",
			role: "admin",
			state: initial,
		});
		expect(await store.resolve("guest")).toEqual({
			kind: "unauthenticated",
			name: "guest",
			role: "guest",
			state: EMPTY_STORAGE_STATE,
		});

		await store.refresh({ name: "admin-primary", state: EMPTY_STORAGE_STATE });
		expect(await store.resolve("admin-primary")).toMatchObject({
			state: EMPTY_STORAGE_STATE,
		});

		const profileDirectory = join(
			dataRoot,
			"origins",
			configuredOriginKey(origin),
			"profiles",
			"admin-primary",
		);
		expect(
			(await readdir(join(dataRoot, "origins"))).every(
				(entry) => !entry.startsWith(".tmp-"),
			),
		).toBe(true);
		expect(
			(await readdir(profileDirectory)).every(
				(entry) => !entry.includes(".tmp-"),
			),
		).toBe(true);
		if (process.platform !== "win32") {
			expect((await stat(dataRoot)).mode & 0o777).toBe(0o700);
			expect((await stat(join(dataRoot, "origins"))).mode & 0o777).toBe(0o700);
			expect(
				(await stat(profilePaths(dataRoot).originDirectory)).mode & 0o777,
			).toBe(0o700);
			expect((await stat(profileDirectory)).mode & 0o777).toBe(0o700);
			expect(
				(await stat(join(profileDirectory, "profile.json"))).mode & 0o777,
			).toBe(0o600);
			expect(
				(await stat(join(profileDirectory, "storage-state.json"))).mode & 0o777,
			).toBe(0o600);
		}
	});

	it("stores the same profile name independently for two configured origins", async () => {
		const dataRoot = join(await makeRoot(), "data");
		const customOrigin = "https://shop.example";
		const myshopifyOrigin = "https://shop.myshopify.com";
		const customStore = createProfileStore({
			dataRoot,
			origin: customOrigin,
			roles,
		});
		const myshopifyStore = createProfileStore({
			dataRoot,
			origin: myshopifyOrigin,
			roles,
		});

		await customStore.capture({
			name: "admin-primary",
			role: "admin",
			state: stateWithCookie("custom"),
		});
		await myshopifyStore.capture({
			name: "admin-primary",
			role: "admin",
			state: stateWithCookie("myshopify"),
		});

		expect(await customStore.resolve("admin-primary")).toMatchObject({
			state: { cookies: [{ value: "custom" }] },
		});
		expect(await myshopifyStore.resolve("admin-primary")).toMatchObject({
			state: { cookies: [{ value: "myshopify" }] },
		});
		expect(await readdir(join(dataRoot, "origins"))).toHaveLength(2);
	});

	it("rejects invalid or duplicate capture before exposing a temporary profile", async () => {
		const dataRoot = join(await makeRoot(), "data");
		const store = createProfileStore({
			dataRoot,
			origin: configuredOrigin,
			roles,
		});

		await expect(
			store.capture({
				name: "admin-primary",
				role: "admin",
				state: { cookies: [] },
			}),
		).rejects.toThrow(/storage state/i);
		await expect(lstat(dataRoot)).rejects.toThrow();

		await store.capture({
			name: "admin-primary",
			role: "admin",
			state: EMPTY_STORAGE_STATE,
		});
		await expect(
			store.capture({
				name: "admin-primary",
				role: "admin",
				state: EMPTY_STORAGE_STATE,
			}),
		).rejects.toThrow(/already exists/i);
		expect(
			(await readdir(profilePaths(dataRoot).profilesDirectory)).some((entry) =>
				entry.startsWith(".tmp-"),
			),
		).toBe(false);
	});

	it("keeps an existing state intact when refresh validation fails", async () => {
		const dataRoot = join(await makeRoot(), "data");
		const store = createProfileStore({
			dataRoot,
			origin: "https://shop.example",
			roles,
		});
		await store.capture({
			name: "admin-primary",
			role: "admin",
			state: EMPTY_STORAGE_STATE,
		});
		const statePath = join(
			dataRoot,
			"origins",
			configuredOriginKey("https://shop.example"),
			"profiles",
			"admin-primary",
			"storage-state.json",
		);
		const before = await readFile(statePath);
		const metadataPath = profilePaths(dataRoot).profileMetadata;
		const metadataBefore = await readFile(metadataPath);

		await expect(
			store.refresh({ name: "admin-primary", state: { cookies: [] } }),
		).rejects.toThrow(/storage state/i);
		expect(await readFile(statePath)).toEqual(before);
		expect(await readFile(metadataPath)).toEqual(metadataBefore);
		expect(
			(await readdir(profilePaths(dataRoot).profileDirectory)).some((entry) =>
				entry.includes(".tmp-"),
			),
		).toBe(false);
	});

	it("removes prepared temporary state when capture or refresh aborts before commit", async () => {
		const dataRoot = join(await makeRoot(), "data");
		const store = createProfileStore({
			dataRoot,
			origin: configuredOrigin,
			roles,
		});
		const controller = new AbortController();
		controller.abort("SIGTERM");

		await expect(
			store.capture({
				name: "admin-primary",
				role: "admin",
				signal: controller.signal,
				state: stateWithCookie("not-committed"),
			}),
		).rejects.toBeInstanceOf(CommandSignalError);
		expect(await readdir(join(dataRoot, "origins"))).toEqual([]);

		await store.capture({
			name: "admin-primary",
			role: "admin",
			state: stateWithCookie("prior"),
		});
		const paths = profilePaths(dataRoot);
		const priorBytes = await readFile(paths.state);

		await expect(
			store.capture({
				name: "admin-secondary",
				role: "admin",
				signal: controller.signal,
				state: stateWithCookie("not-committed"),
			}),
		).rejects.toBeInstanceOf(CommandSignalError);
		expect(await readdir(paths.profilesDirectory)).toEqual(["admin-primary"]);

		await expect(
			store.refresh({
				name: "admin-primary",
				signal: controller.signal,
				state: stateWithCookie("replacement"),
			}),
		).rejects.toBeInstanceOf(CommandSignalError);
		expect(await readFile(paths.state)).toEqual(priorBytes);
		expect(
			(await readdir(paths.profileDirectory)).some((entry) =>
				entry.includes(".tmp-"),
			),
		).toBe(false);
	});

	it("fails closed for symlinked state and safely lists invalid entries", async () => {
		const root = await makeRoot();
		const dataRoot = join(root, "data");
		const store = createProfileStore({
			dataRoot,
			origin: "https://shop.example",
			roles,
		});
		await store.capture({
			name: "admin-primary",
			role: "admin",
			state: EMPTY_STORAGE_STATE,
		});
		const profileDirectory = join(
			dataRoot,
			"origins",
			configuredOriginKey("https://shop.example"),
			"profiles",
			"admin-primary",
		);
		const statePath = join(profileDirectory, "storage-state.json");
		const outsideState = join(root, "outside-state.json");
		await writeFile(outsideState, JSON.stringify(EMPTY_STORAGE_STATE));
		await rm(statePath);
		await symlink(outsideState, statePath);

		await expect(store.resolve("admin-primary")).rejects.toThrow(/invalid/i);
		expect(await store.list()).toEqual([
			{ name: "admin-primary", role: "admin", status: "invalid" },
		]);
	});

	it("does not create persisted state for unauthenticated roles", async () => {
		const dataRoot = join(await makeRoot(), "data");
		const store = createProfileStore({
			dataRoot,
			origin: "https://shop.example",
			roles,
		});

		expect(await store.resolve("guest")).toMatchObject({
			kind: "unauthenticated",
		});
		await expect(lstat(dataRoot)).rejects.toThrow();
		await expect(
			store.capture({
				name: "guest",
				role: "admin",
				state: EMPTY_STORAGE_STATE,
			}),
		).rejects.toThrow(/collide/i);
		await expect(store.resolve("../admin")).rejects.toThrow(/lower-kebab/i);
	});

	it("fails closed for symlinked registry parents", async () => {
		if (process.platform === "win32") return;
		const root = await makeRoot();
		const dataRoot = join(root, "data");
		const outside = join(root, "outside");
		await mkdir(dataRoot);
		await mkdir(outside);
		await symlink(outside, join(dataRoot, "origins"));
		const store = createProfileStore({
			dataRoot,
			origin: configuredOrigin,
			roles,
		});

		await expect(store.list()).rejects.toThrow(/registry.*invalid/i);
		await expect(
			store.capture({
				name: "admin-primary",
				role: "admin",
				state: EMPTY_STORAGE_STATE,
			}),
		).rejects.toThrow(/registry.*invalid/i);
		expect(await readdir(outside)).toEqual([]);
	});

	it("treats absent partitions as empty and corrupt origin metadata as fatal", async () => {
		const dataRoot = join(await makeRoot(), "data");
		const store = createProfileStore({
			dataRoot,
			origin: configuredOrigin,
			roles,
		});
		expect(await store.list()).toEqual([]);

		await store.capture({
			name: "admin-primary",
			role: "admin",
			state: EMPTY_STORAGE_STATE,
		});
		const { originMetadata } = profilePaths(dataRoot);
		const validMetadata = await readFile(originMetadata);
		for (const invalidMetadata of [
			"{",
			JSON.stringify({ origin: configuredOrigin, schemaVersion: 2 }),
			JSON.stringify({
				origin: "https://another-shop.example",
				schemaVersion: 1,
			}),
		]) {
			await writeFile(originMetadata, invalidMetadata);
			await expect(store.list()).rejects.toThrow(/invalid/i);
			await writeFile(originMetadata, validMetadata);
		}

		await rm(originMetadata);
		await expect(store.list()).rejects.toThrow(/invalid/i);
		await writeFile(originMetadata, validMetadata);
		await rm(profilePaths(dataRoot).profilesDirectory, { recursive: true });
		await expect(store.list()).rejects.toThrow(/registry.*invalid/i);
	});

	it("reports non-regular profile entries without returning a path", async () => {
		const dataRoot = join(await makeRoot(), "data");
		const store = createProfileStore({
			dataRoot,
			origin: configuredOrigin,
			roles,
		});
		await store.capture({
			name: "admin-primary",
			role: "admin",
			state: EMPTY_STORAGE_STATE,
		});
		const { profilesDirectory } = profilePaths(dataRoot);
		const nonRegularPath = join(profilesDirectory, "file-profile");
		await writeFile(nonRegularPath, "bearer-secret");

		expect(await store.list()).toContainEqual({
			name: "file-profile",
			role: "unknown",
			status: "invalid",
		});
		const error = await store
			.resolve("file-profile")
			.catch((cause: unknown) => cause);
		expect(String(error)).not.toContain(nonRegularPath);
		expect(String(error)).not.toContain("bearer-secret");
	});

	it("preserves prior bytes and cleans temporary state after write and rename failures", async () => {
		type FileSystemPromises = typeof import("node:fs/promises");
		const actual =
			await vi.importActual<FileSystemPromises>("node:fs/promises");
		let failure:
			| "origin-rename"
			| "origin-write"
			| "profile-rename"
			| "profile-write"
			| "refresh-rename"
			| "refresh-write"
			| undefined;
		const rawCause =
			"raw-cause bearer-secret /private/final/storage-state.json";

		vi.doMock("node:fs/promises", () => ({
			...actual,
			rename: async (
				...args: Parameters<FileSystemPromises["rename"]>
			): ReturnType<FileSystemPromises["rename"]> => {
				const source = String(args[0]);
				if (
					(failure === "refresh-rename" &&
						source.includes("storage-state.json.tmp-")) ||
					(failure === "profile-rename" &&
						source.includes(".tmp-admin-secondary-")) ||
					(failure === "origin-rename" && source.includes(".tmp-origin-"))
				) {
					throw new Error(rawCause);
				}
				return actual.rename(args[0], args[1]);
			},
			writeFile: async (
				...args: Parameters<FileSystemPromises["writeFile"]>
			): ReturnType<FileSystemPromises["writeFile"]> => {
				const target = String(args[0]);
				if (
					(failure === "refresh-write" &&
						target.includes("storage-state.json.tmp-")) ||
					(failure === "profile-write" &&
						target.includes(".tmp-admin-secondary-") &&
						target.endsWith("storage-state.json")) ||
					(failure === "origin-write" &&
						target.includes(".tmp-origin-") &&
						target.endsWith("origin.json"))
				) {
					throw new Error(rawCause);
				}
				return actual.writeFile(args[0], args[1], args[2]);
			},
		}));
		vi.resetModules();

		try {
			const { createProfileStore: createStoreWithMockedFileSystem } =
				await import("../src/profiles/profile-store.js");
			const dataRoot = join(await makeRoot(), "data");
			const store = createStoreWithMockedFileSystem({
				dataRoot,
				origin: configuredOrigin,
				roles,
			});
			await store.capture({
				name: "admin-primary",
				role: "admin",
				state: stateWithCookie("prior"),
			});
			const paths = profilePaths(dataRoot);
			const priorBytes = await readFile(paths.state);

			for (const injectedFailure of [
				"refresh-write",
				"refresh-rename",
			] as const) {
				failure = injectedFailure;
				const error = await store
					.refresh({
						name: "admin-primary",
						state: stateWithCookie("replacement"),
					})
					.catch((cause: unknown) => cause);
				expect(String(error)).toContain("previous state is unchanged");
				expect(String(error)).not.toContain("bearer-secret");
				expect(String(error)).not.toContain("storage-state.json");
				expect(await readFile(paths.state)).toEqual(priorBytes);
				expect(
					(await readdir(paths.profileDirectory)).some((entry) =>
						entry.includes("storage-state.json.tmp-"),
					),
				).toBe(false);
			}

			for (const injectedFailure of [
				"profile-write",
				"profile-rename",
			] as const) {
				failure = injectedFailure;
				const error = await store
					.capture({
						name: "admin-secondary",
						role: "admin",
						state: stateWithCookie("not-committed"),
					})
					.catch((cause: unknown) => cause);
				expect(String(error)).toContain("Profile could not be saved");
				expect(String(error)).not.toContain("bearer-secret");
				expect(await readdir(paths.profilesDirectory)).toEqual([
					"admin-primary",
				]);
				expect(await readFile(paths.state)).toEqual(priorBytes);
			}

			for (const injectedFailure of [
				"origin-write",
				"origin-rename",
			] as const) {
				failure = injectedFailure;
				const freshDataRoot = join(await makeRoot(), "data");
				const freshStore = createStoreWithMockedFileSystem({
					dataRoot: freshDataRoot,
					origin: configuredOrigin,
					roles,
				});
				const error = await freshStore
					.capture({
						name: "admin-primary",
						role: "admin",
						state: stateWithCookie("not-committed"),
					})
					.catch((cause: unknown) => cause);
				expect(String(error)).toContain("Profile could not be saved");
				expect(String(error)).not.toContain("bearer-secret");
				expect(await readdir(join(freshDataRoot, "origins"))).toEqual([]);
			}
		} finally {
			vi.doUnmock("node:fs/promises");
			vi.resetModules();
		}
	});

	it("rolls back origin, profile, and refresh commits when interrupted during rename", async () => {
		type FileSystemPromises = typeof import("node:fs/promises");
		const actual =
			await vi.importActual<FileSystemPromises>("node:fs/promises");
		let abortController: AbortController | undefined;
		let abortOn: "origin" | "profile" | "refresh" | undefined;

		vi.doMock("node:fs/promises", () => ({
			...actual,
			rename: async (
				...args: Parameters<FileSystemPromises["rename"]>
			): ReturnType<FileSystemPromises["rename"]> => {
				const source = String(args[0]);
				await actual.rename(args[0], args[1]);
				if (
					(abortOn === "origin" && source.includes(".tmp-origin-")) ||
					(abortOn === "profile" && source.includes(".tmp-admin-secondary-")) ||
					(abortOn === "refresh" && source.includes("storage-state.json.tmp-"))
				) {
					abortController?.abort("SIGTERM");
				}
			},
		}));
		vi.resetModules();

		try {
			const { createProfileStore: createStoreWithMockedFileSystem } =
				await import("../src/profiles/profile-store.js");

			const firstDataRoot = join(await makeRoot(), "data");
			const firstStore = createStoreWithMockedFileSystem({
				dataRoot: firstDataRoot,
				origin: configuredOrigin,
				roles,
			});
			abortController = new AbortController();
			abortOn = "origin";
			await expect(
				firstStore.capture({
					name: "admin-primary",
					role: "admin",
					signal: abortController.signal,
					state: stateWithCookie("not-committed"),
				}),
			).rejects.toMatchObject({ exitCode: 143, signal: "SIGTERM" });
			expect(await readdir(join(firstDataRoot, "origins"))).toEqual([]);

			const dataRoot = join(await makeRoot(), "data");
			const store = createStoreWithMockedFileSystem({
				dataRoot,
				origin: configuredOrigin,
				roles,
			});
			abortOn = undefined;
			abortController = undefined;
			await store.capture({
				name: "admin-primary",
				role: "admin",
				state: stateWithCookie("prior"),
			});
			const paths = profilePaths(dataRoot);
			const priorBytes = await readFile(paths.state);

			abortController = new AbortController();
			abortOn = "profile";
			await expect(
				store.capture({
					name: "admin-secondary",
					role: "admin",
					signal: abortController.signal,
					state: stateWithCookie("not-committed"),
				}),
			).rejects.toMatchObject({ exitCode: 143, signal: "SIGTERM" });
			expect(await readdir(paths.profilesDirectory)).toEqual(["admin-primary"]);

			abortController = new AbortController();
			abortOn = "refresh";
			await expect(
				store.refresh({
					name: "admin-primary",
					signal: abortController.signal,
					state: stateWithCookie("replacement"),
				}),
			).rejects.toMatchObject({ exitCode: 143, signal: "SIGTERM" });
			expect(await readFile(paths.state)).toEqual(priorBytes);
			expect(
				(await readdir(paths.profileDirectory)).filter((entry) =>
					entry.includes("storage-state.json."),
				),
			).toEqual([]);
		} finally {
			vi.doUnmock("node:fs/promises");
			vi.resetModules();
		}
	});

	it("rejects malformed, oversized, orphaned, and reclassified saved profiles", async () => {
		const dataRoot = join(await makeRoot(), "data");
		const store = createProfileStore({
			dataRoot,
			origin: configuredOrigin,
			roles,
		});
		await store.capture({
			name: "admin-primary",
			role: "admin",
			state: EMPTY_STORAGE_STATE,
		});
		const paths = profilePaths(dataRoot);
		const validMetadata = await readFile(paths.profileMetadata);
		const validState = await readFile(paths.state);

		await writeFile(
			paths.state,
			JSON.stringify({ cookies: [], origins: "bad" }),
		);
		await expect(store.resolve("admin-primary")).rejects.toThrow(
			/storage state/i,
		);
		await writeFile(paths.state, validState);

		await truncate(paths.state, MAX_STORAGE_STATE_BYTES + 1);
		await expect(store.resolve("admin-primary")).rejects.toThrow(/invalid/i);
		await writeFile(paths.state, validState);

		await writeFile(paths.profileMetadata, "x".repeat(MAX_METADATA_BYTES + 1));
		await expect(store.resolve("admin-primary")).rejects.toThrow(/invalid/i);
		await writeFile(paths.profileMetadata, validMetadata);

		const orphaned = createProfileStore({
			dataRoot,
			origin: configuredOrigin,
			roles: { guest: { authentication: "none" } },
		});
		await expect(orphaned.resolve("admin-primary")).rejects.toThrow(/invalid/i);
		expect(await orphaned.list()).toEqual([
			{ name: "admin-primary", role: "admin", status: "invalid" },
		]);
	});

	it("fails closed across profile metadata corruption without exposing values", async () => {
		const dataRoot = join(await makeRoot(), "data");
		const store = createProfileStore({
			dataRoot,
			origin: configuredOrigin,
			roles,
		});
		await store.capture({
			name: "admin-primary",
			role: "admin",
			state: EMPTY_STORAGE_STATE,
		});
		const paths = profilePaths(dataRoot);
		const validMetadata = await readFile(paths.profileMetadata);
		const invalidMetadata = [
			"{",
			JSON.stringify({
				name: "admin-primary",
				origin: configuredOrigin,
				role: "admin",
				schemaVersion: 2,
			}),
			JSON.stringify({
				name: "different-profile",
				origin: configuredOrigin,
				role: "admin",
				schemaVersion: 1,
			}),
			JSON.stringify({
				name: "admin-primary",
				origin: "https://different.example",
				role: "admin",
				schemaVersion: 1,
			}),
			JSON.stringify({
				extra: "bearer-secret",
				name: "admin-primary",
				origin: configuredOrigin,
				role: "admin",
				schemaVersion: 1,
			}),
		];

		for (const contents of invalidMetadata) {
			await writeFile(paths.profileMetadata, contents);
			const error = await store
				.resolve("admin-primary")
				.catch((cause: unknown) => cause);
			expect(error).toBeInstanceOf(Error);
			expect(String(error)).not.toMatch(/bearer-secret|different\.example/);
			const listing = await store.list();
			expect(listing).toHaveLength(1);
			expect(listing[0]).toMatchObject({
				name: "admin-primary",
				status: "invalid",
			});
			expect(listing[0]?.role).toMatch(/^(?:admin|unknown)$/);
			await writeFile(paths.profileMetadata, validMetadata);
		}
	});

	it("rejects missing and non-regular profile files without fallback", async () => {
		const dataRoot = join(await makeRoot(), "data");
		const store = createProfileStore({
			dataRoot,
			origin: configuredOrigin,
			roles,
		});
		await store.capture({
			name: "admin-primary",
			role: "admin",
			state: stateWithCookie("prior"),
		});
		const paths = profilePaths(dataRoot);
		const validMetadata = await readFile(paths.profileMetadata);
		const validState = await readFile(paths.state);

		for (const [path, validBytes] of [
			[paths.profileMetadata, validMetadata],
			[paths.state, validState],
		] as const) {
			await rm(path);
			await expect(store.resolve("admin-primary")).rejects.toThrow(/invalid/i);
			await mkdir(path);
			await expect(store.resolve("admin-primary")).rejects.toThrow(/invalid/i);
			await rm(path, { recursive: true });
			await writeFile(path, validBytes);
		}

		expect(await store.resolve("admin-primary")).toMatchObject({
			kind: "saved",
			role: "admin",
			state: { cookies: [{ value: "prior" }] },
		});
	});

	it.skipIf(process.platform === "win32")(
		"rejects symlinked origin metadata and profile metadata",
		async () => {
			const root = await makeRoot();
			const dataRoot = join(root, "data");
			const store = createProfileStore({
				dataRoot,
				origin: configuredOrigin,
				roles,
			});
			await store.capture({
				name: "admin-primary",
				role: "admin",
				state: EMPTY_STORAGE_STATE,
			});
			const paths = profilePaths(dataRoot);
			const targets = [paths.originMetadata, paths.profileMetadata];

			for (const path of targets) {
				const validBytes = await readFile(path);
				const outside = join(root, `outside-${targets.indexOf(path)}.json`);
				await writeFile(outside, validBytes);
				await rm(path);
				await symlink(outside, path);
				await expect(store.resolve("admin-primary")).rejects.toThrow(
					/invalid/i,
				);
				await rm(path);
				await writeFile(path, validBytes);
			}
		},
	);

	it("rejects oversized origin metadata and preserves an existing valid partition", async () => {
		const dataRoot = join(await makeRoot(), "data");
		const store = createProfileStore({
			dataRoot,
			origin: configuredOrigin,
			roles,
		});
		await store.capture({
			name: "admin-primary",
			role: "admin",
			state: EMPTY_STORAGE_STATE,
		});
		const paths = profilePaths(dataRoot);
		const validMetadata = await readFile(paths.originMetadata);
		await writeFile(paths.originMetadata, "x".repeat(MAX_METADATA_BYTES + 1));

		await expect(store.list()).rejects.toThrow(/invalid/i);
		await expect(
			store.capture({
				name: "admin-secondary",
				role: "admin",
				state: EMPTY_STORAGE_STATE,
			}),
		).rejects.toThrow(/invalid/i);
		await writeFile(paths.originMetadata, validMetadata);
		expect(await store.resolve("admin-primary")).toMatchObject({
			kind: "saved",
			name: "admin-primary",
		});
	});

	it("sorts listing and replaces unsafe names and roles with fixed placeholders", async () => {
		const dataRoot = join(await makeRoot(), "data");
		const store = createProfileStore({
			dataRoot,
			origin: configuredOrigin,
			roles,
		});
		await store.capture({
			name: "zeta-profile",
			role: "admin",
			state: EMPTY_STORAGE_STATE,
		});
		const { profilesDirectory } = profilePaths(dataRoot, "zeta-profile");
		await mkdir(join(profilesDirectory, "unsafe\nname"));
		const invalidRoleDirectory = join(profilesDirectory, "alpha-profile");
		await mkdir(invalidRoleDirectory);
		await writeFile(
			join(invalidRoleDirectory, "profile.json"),
			JSON.stringify({
				name: "alpha-profile",
				origin: configuredOrigin,
				role: "bearer-secret\n",
				schemaVersion: 1,
			}),
		);
		await writeFile(
			join(invalidRoleDirectory, "storage-state.json"),
			JSON.stringify(EMPTY_STORAGE_STATE),
		);

		const listing = await store.list();
		expect(listing).toContainEqual({
			name: "<invalid-name>",
			role: "unknown",
			status: "invalid",
		});
		expect(listing).toContainEqual({
			name: "alpha-profile",
			role: "unknown",
			status: "invalid",
		});
		expect(JSON.stringify(listing)).not.toContain("bearer-secret");
		expect(listing).toEqual(
			[...listing].sort((left, right) =>
				`${left.name}\0${left.role}`.localeCompare(
					`${right.name}\0${right.role}`,
				),
			),
		);
	});
});
