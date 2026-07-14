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
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { configuredOriginKey } from "../src/profiles/configured-origin.js";
import {
	createProfileStore,
	EMPTY_STORAGE_STATE,
} from "../src/profiles/profile-store.js";

const temporaryDirectories: string[] = [];

const makeRoot = async (): Promise<string> => {
	const root = await mkdtemp(join(tmpdir(), "shopify-e2e-removal-"));
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
		profileDirectory,
		profilesDirectory: join(originDirectory, "profiles"),
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
	vi.doUnmock("node:fs/promises");
	vi.resetModules();
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

describe("profile removal", () => {
	it("discovers and removes only real path-safe saved profile directories", async () => {
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
		await mkdir(join(profilesDirectory, "corrupt-profile"));
		await writeFile(
			join(profilesDirectory, "corrupt-profile", "profile.json"),
			"not-json bearer-secret",
		);
		const guestDirectory = join(profilesDirectory, "guest");
		await mkdir(guestDirectory);
		await writeFile(join(guestDirectory, "keep.txt"), "keep-me");
		await mkdir(join(profilesDirectory, ".tmp-remove-hidden"));
		await mkdir(join(profilesDirectory, "unsafe name"));
		await writeFile(join(profilesDirectory, "file-profile"), "bearer-secret");
		const outside = join(await makeRoot(), "outside-profile");
		await mkdir(outside);
		await symlink(outside, join(profilesDirectory, "linked-profile"));

		expect(await store.removableProfiles()).toEqual([
			"admin-primary",
			"corrupt-profile",
		]);
		for (const name of ["file-profile", "guest", "linked-profile"]) {
			await expect(store.remove({ name })).rejects.toMatchObject({
				exitCode: 2,
			});
		}
		expect(await readFile(join(guestDirectory, "keep.txt"), "utf8")).toBe(
			"keep-me",
		);

		const outsideSecret = join(outside, "outside-secret");
		await writeFile(outsideSecret, "keep-me");
		await symlink(outside, join(profilesDirectory, "corrupt-profile", "child"));
		await store.remove({ name: "corrupt-profile" });

		expect(await store.removableProfiles()).toEqual(["admin-primary"]);
		expect(await readFile(outsideSecret, "utf8")).toBe("keep-me");
		expect(await readdir(profilesDirectory)).not.toContain("corrupt-profile");
		expect(
			(await readdir(profilesDirectory)).every(
				(entry) => !entry.startsWith(".tmp-remove-corrupt-profile-"),
			),
		).toBe(true);
	});

	it("does not initialize storage while checking or removing from a fresh store", async () => {
		const dataRoot = join(await makeRoot(), "data");
		const store = createProfileStore({
			dataRoot,
			origin: configuredOrigin,
			roles,
		});

		expect(await store.removableProfiles()).toEqual([]);
		const error = await store
			.remove({ name: "admin-primary" })
			.catch((cause: unknown) => cause);
		expect(error).toMatchObject({ exitCode: 2 });
		expect(String(error)).not.toContain(dataRoot);
		await expect(lstat(dataRoot)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("removes only current-origin profiles while retaining empty partitions", async () => {
		const dataRoot = join(await makeRoot(), "data");
		const otherOrigin = "https://other-shop.example";
		const currentStore = createProfileStore({
			dataRoot,
			origin: configuredOrigin,
			roles,
		});
		const otherStore = createProfileStore({
			dataRoot,
			origin: otherOrigin,
			roles,
		});
		for (const store of [currentStore, otherStore]) {
			await store.capture({
				name: "admin-primary",
				role: "admin",
				state: EMPTY_STORAGE_STATE,
			});
		}
		await currentStore.capture({
			name: "admin-sibling",
			role: "admin",
			state: EMPTY_STORAGE_STATE,
		});

		for (const name of ["../escape", "<invalid-name>", "guest", "unknown"]) {
			const error = await currentStore
				.remove({ name })
				.catch((cause: unknown) => cause);
			expect(error).toMatchObject({ exitCode: 2 });
			expect(String(error)).not.toContain(dataRoot);
		}

		await currentStore.remove({ name: "admin-primary" });

		expect(await currentStore.removableProfiles()).toEqual(["admin-sibling"]);
		expect(await otherStore.removableProfiles()).toEqual(["admin-primary"]);
		expect(
			await readdir(profilePaths(dataRoot, "admin-primary").profilesDirectory),
		).toContain("admin-sibling");
		await currentStore.remove({ name: "admin-sibling" });
		expect(
			await stat(profilePaths(dataRoot, "admin-sibling").profilesDirectory),
		).toMatchObject({});
	});

	it("removes profiles whose stored roles were removed or reclassified", async () => {
		const dataRoot = join(await makeRoot(), "data");
		const captureStore = createProfileStore({
			dataRoot,
			origin: configuredOrigin,
			roles: {
				admin: { authentication: "required" },
				buyer: { authentication: "required" },
				operator: { authentication: "required" },
			},
		});
		for (const [name, role] of [
			["legacy-removed", "admin"],
			["legacy-reclassified", "operator"],
			["buyer-sibling", "buyer"],
		] as const) {
			await captureStore.capture({ name, role, state: EMPTY_STORAGE_STATE });
		}
		const removalStore = createProfileStore({
			dataRoot,
			origin: configuredOrigin,
			roles: {
				buyer: { authentication: "required" },
				operator: { authentication: "none" },
			},
		});

		expect(await removalStore.removableProfiles()).toEqual([
			"buyer-sibling",
			"legacy-reclassified",
			"legacy-removed",
		]);
		await removalStore.remove({ name: "legacy-removed" });
		await removalStore.remove({ name: "legacy-reclassified" });

		expect(await removalStore.removableProfiles()).toEqual(["buyer-sibling"]);
		expect(
			(
				await lstat(profilePaths(dataRoot, "buyer-sibling").profileDirectory)
			).isDirectory(),
		).toBe(true);
	});

	it("keeps removal truthful across preparation, signal, and cleanup boundaries", async () => {
		type FileSystemPromises = typeof import("node:fs/promises");
		const actual =
			await vi.importActual<FileSystemPromises>("node:fs/promises");
		const rawCause =
			"raw removal cause bearer-secret /private/storage-state.json";
		let abortController: AbortController | undefined;
		let failure:
			| "cleanup"
			| "initial-lstat"
			| "mkdtemp"
			| "precommit-cleanup"
			| "rename"
			| "revalidation-lstat"
			| "stale-target"
			| undefined;
		let abortBeforeRename = false;
		let abortDuringCleanup = false;
		let cleanupRelease: (() => void) | undefined;
		let removalCalls = 0;
		let removalOptions: Parameters<FileSystemPromises["rm"]>[1] | undefined;
		let targetLstatCalls = 0;

		vi.doMock("node:fs/promises", () => ({
			...actual,
			chmod: async (
				...args: Parameters<FileSystemPromises["chmod"]>
			): ReturnType<FileSystemPromises["chmod"]> => {
				await actual.chmod(args[0], args[1]);
				if (
					abortBeforeRename &&
					String(args[0]).includes(".tmp-remove-admin-primary-")
				) {
					abortController?.abort("SIGINT");
				}
			},
			lstat: async (
				...args: Parameters<FileSystemPromises["lstat"]>
			): ReturnType<FileSystemPromises["lstat"]> => {
				if (String(args[0]).endsWith("/profiles/admin-primary")) {
					targetLstatCalls += 1;
					if (
						failure === "initial-lstat" ||
						(failure === "revalidation-lstat" && targetLstatCalls === 2)
					) {
						throw Object.assign(new Error(rawCause), { code: "EIO" });
					}
				}
				return actual.lstat(...args);
			},
			mkdtemp: async (
				...args: Parameters<FileSystemPromises["mkdtemp"]>
			): ReturnType<FileSystemPromises["mkdtemp"]> => {
				if (
					failure === "mkdtemp" &&
					String(args[0]).includes(".tmp-remove-admin-primary-")
				) {
					throw new Error(rawCause);
				}
				const temporary = await actual.mkdtemp(...args);
				if (
					failure === "stale-target" &&
					String(args[0]).includes(".tmp-remove-admin-primary-")
				) {
					const target = String(args[0]).replace(
						/\.tmp-remove-admin-primary-$/,
						"admin-primary",
					);
					await actual.rm(target, { force: true, recursive: true });
					await actual.writeFile(target, "stale replacement");
				}
				return temporary;
			},
			rename: async (
				...args: Parameters<FileSystemPromises["rename"]>
			): ReturnType<FileSystemPromises["rename"]> => {
				if (
					(failure === "rename" || failure === "precommit-cleanup") &&
					String(args[1]).endsWith("/profile") &&
					String(args[1]).includes(".tmp-remove-admin-primary-")
				) {
					throw new Error(rawCause);
				}
				return actual.rename(args[0], args[1]);
			},
			rm: async (
				...args: Parameters<FileSystemPromises["rm"]>
			): ReturnType<FileSystemPromises["rm"]> => {
				const target = String(args[0]);
				if (target.includes(".tmp-remove-admin-primary-")) {
					if (String(target).endsWith("/profile")) {
						return actual.rm(args[0], args[1]);
					}
					if (failure === "precommit-cleanup") throw new Error(rawCause);
					if (args[1] && "maxRetries" in args[1]) {
						removalCalls += 1;
						removalOptions = args[1];
						if (abortDuringCleanup) {
							abortController?.abort("SIGTERM");
							await new Promise<void>((resolve) => {
								cleanupRelease = resolve;
							});
						}
						if (failure === "cleanup") {
							const entries = await actual.readdir(args[0]);
							if (entries.length > 0) {
								await actual.writeFile(
									join(String(args[0]), "partial-marker"),
									"partial",
								);
							}
							throw new Error(rawCause);
						}
					}
				}
				return actual.rm(args[0], args[1]);
			},
		}));
		vi.resetModules();

		const { createProfileStore: createStoreWithMockedFileSystem } =
			await import("../src/profiles/profile-store.js");
		const newStore = async () => {
			failure = undefined;
			targetLstatCalls = 0;
			const dataRoot = join(await makeRoot(), "data");
			const store = createStoreWithMockedFileSystem({
				dataRoot,
				origin: configuredOrigin,
				roles,
			});
			await store.capture({
				name: "admin-primary",
				role: "admin",
				state: stateWithCookie("bearer-secret"),
			});
			targetLstatCalls = 0;
			return { dataRoot, store };
		};

		for (const injectedFailure of [
			"initial-lstat",
			"mkdtemp",
			"rename",
			"revalidation-lstat",
		] as const) {
			const { dataRoot, store } = await newStore();
			failure = injectedFailure;
			const error = await store
				.remove({ name: "admin-primary" })
				.catch((cause: unknown) => cause);
			expect(error).toMatchObject({ exitCode: 1 });
			expect(String(error)).toContain("no saved profile changed");
			expect(String(error)).not.toContain(rawCause);
			expect(String(error)).not.toContain("bearer-secret");
			expect(String(error)).not.toContain("storage-state.json");
			expect(await store.removableProfiles()).toEqual(["admin-primary"]);
			expect(
				(await readdir(profilePaths(dataRoot).profilesDirectory)).filter(
					(entry) => entry.startsWith(".tmp-remove-"),
				),
			).toEqual([]);
		}

		{
			const { dataRoot, store } = await newStore();
			failure = "precommit-cleanup";
			const error = await store
				.remove({ name: "admin-primary" })
				.catch((cause: unknown) => cause);
			expect(String(error)).toContain("preparation could not be cleaned");
			expect(String(error)).not.toContain("bearer-secret");
			expect(await store.removableProfiles()).toEqual(["admin-primary"]);
			expect(
				(await readdir(profilePaths(dataRoot).profilesDirectory)).some(
					(entry) => entry.startsWith(".tmp-remove-admin-primary-"),
				),
			).toBe(true);
		}

		{
			const { dataRoot, store } = await newStore();
			failure = "stale-target";
			await expect(
				store.remove({ name: "admin-primary" }),
			).rejects.toMatchObject({ exitCode: 2 });
			expect(
				(await lstat(profilePaths(dataRoot).profileDirectory)).isFile(),
			).toBe(true);
			expect(
				(await readdir(profilePaths(dataRoot).profilesDirectory)).filter(
					(entry) => entry.startsWith(".tmp-remove-"),
				),
			).toEqual([]);
		}

		abortBeforeRename = true;
		abortController = new AbortController();
		{
			const { dataRoot, store } = await newStore();
			abortBeforeRename = true;
			await expect(
				store.remove({
					name: "admin-primary",
					signal: abortController.signal,
				}),
			).rejects.toMatchObject({ exitCode: 130, signal: "SIGINT" });
			expect(await store.removableProfiles()).toEqual(["admin-primary"]);
			expect(
				(await readdir(profilePaths(dataRoot).profilesDirectory)).filter(
					(entry) => entry.startsWith(".tmp-remove-"),
				),
			).toEqual([]);
		}

		abortBeforeRename = false;
		{
			const { dataRoot, store } = await newStore();
			failure = "cleanup";
			const error = await store
				.remove({ name: "admin-primary" })
				.catch((cause: unknown) => cause);
			expect(error).toMatchObject({ exitCode: 1 });
			expect(String(error)).toContain(
				"unavailable, but local secret cleanup is incomplete",
			);
			expect(String(error)).not.toContain("bearer-secret");
			expect(await store.removableProfiles()).toEqual([]);
			const quarantine = (
				await readdir(profilePaths(dataRoot).profilesDirectory)
			).find((entry) => entry.startsWith(".tmp-remove-admin-primary-"));
			expect(quarantine).toBeDefined();
			if (process.platform !== "win32" && quarantine) {
				expect(
					(
						await stat(
							join(profilePaths(dataRoot).profilesDirectory, quarantine),
						)
					).mode & 0o777,
				).toBe(0o700);
			}
			expect(removalOptions).toMatchObject({
				force: true,
				maxRetries: 2,
				recursive: true,
				retryDelay: 100,
			});
			expect(removalCalls).toBe(1);
		}

		abortDuringCleanup = true;
		abortController = new AbortController();
		{
			const { store } = await newStore();
			abortDuringCleanup = true;
			let settled = false;
			const removal = store
				.remove({ name: "admin-primary", signal: abortController.signal })
				.then(() => {
					settled = true;
				});
			await vi.waitFor(() =>
				expect(abortController?.signal.aborted).toBe(true),
			);
			expect(settled).toBe(false);
			cleanupRelease?.();
			await removal;
			expect(settled).toBe(true);
			expect(await store.removableProfiles()).toEqual([]);
		}
	});
});
