import {
	access,
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
import { basename, dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { configuredOriginKey } from "../src/role-states/configured-origin.js";
import {
	createRoleStateStore,
	type RoleStateStore,
} from "../src/role-states/role-state-store.js";

const temporaryDirectories: string[] = [];
const configuredOrigin = "https://shop.example";

const makeRoot = async (): Promise<string> => {
	const root = await mkdtemp(join(tmpdir(), "shopify-e2e-role-states-"));
	temporaryDirectories.push(root);
	return realpath(root);
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

const roleStatePaths = (
	dataRoot: string,
	role = "admin",
	origin = configuredOrigin,
) => {
	const originDirectory = join(
		dataRoot,
		"origins",
		configuredOriginKey(origin),
	);
	const statesDirectory = join(originDirectory, "role-states");
	const roleDirectory = join(statesDirectory, role);
	return {
		legacyProfiles: join(originDirectory, "profiles"),
		metadata: join(roleDirectory, "role-state.json"),
		originDirectory,
		roleDirectory,
		state: join(roleDirectory, "storage-state.json"),
		statesDirectory,
	};
};

const makeStore = async (
	roles: readonly string[] = ["admin", "customer"],
): Promise<{ dataRoot: string; store: RoleStateStore }> => {
	const dataRoot = join(await makeRoot(), "data");
	return {
		dataRoot,
		store: createRoleStateStore({
			dataRoot,
			origin: configuredOrigin,
			roles,
		}),
	};
};

afterEach(async () => {
	vi.doUnmock("node:fs/promises");
	vi.resetModules();
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

describe("role state store", () => {
	it("captures one state per role, resolves it, refreshes it, and uses owner-only files", async () => {
		const { dataRoot, store } = await makeStore();
		const initial = stateWithCookie("initial-secret");

		await store.capture({ role: "admin", state: initial });

		expect(await store.list()).toEqual([
			{ role: "admin", status: "ready" },
			{ role: "customer", status: "missing" },
		]);
		expect(await store.resolve("admin")).toEqual({
			role: "admin",
			state: initial,
		});
		await expect(
			store.capture({ role: "admin", state: initial }),
		).rejects.toThrow(/already exists/i);

		await store.refresh({
			role: "admin",
			state: stateWithCookie("refreshed-secret"),
		});
		expect(await store.resolve("admin")).toMatchObject({
			state: { cookies: [{ value: "refreshed-secret" }] },
		});

		const paths = roleStatePaths(dataRoot);
		expect(
			(await readdir(paths.roleDirectory)).every(
				(entry) => !entry.includes(".tmp-") && !entry.includes(".rollback-"),
			),
		).toBe(true);
		if (process.platform !== "win32") {
			expect((await stat(dataRoot)).mode & 0o777).toBe(0o700);
			expect((await stat(paths.originDirectory)).mode & 0o777).toBe(0o700);
			expect((await stat(paths.statesDirectory)).mode & 0o777).toBe(0o700);
			expect((await stat(paths.roleDirectory)).mode & 0o777).toBe(0o700);
			expect((await stat(paths.metadata)).mode & 0o777).toBe(0o600);
			expect((await stat(paths.state)).mode & 0o777).toBe(0o600);
		}
	});

	it("isolates the same role across normalized origins", async () => {
		const dataRoot = join(await makeRoot(), "data");
		const first = createRoleStateStore({
			dataRoot,
			origin: "https://one.example",
			roles: ["admin"],
		});
		const second = createRoleStateStore({
			dataRoot,
			origin: "https://two.example",
			roles: ["admin"],
		});

		await first.capture({ role: "admin", state: stateWithCookie("one") });
		await second.capture({ role: "admin", state: stateWithCookie("two") });

		expect((await first.resolve("admin")).state.cookies[0]?.value).toBe("one");
		expect((await second.resolve("admin")).state.cookies[0]?.value).toBe("two");
	});

	it("rejects unknown and missing roles without creating state", async () => {
		const { dataRoot, store } = await makeStore(["admin"]);

		await expect(store.resolve("customer")).rejects.toThrow(/not configured/i);
		await expect(
			store.capture({ role: "customer", state: stateWithCookie("secret") }),
		).rejects.toThrow(/not configured/i);
		await expect(store.resolve("admin")).rejects.toThrow(/missing or invalid/i);
		await expect(access(dataRoot)).rejects.toThrow();
	});

	it("classifies safe corrupt entries as invalid and safe unconfigured directories as orphaned", async () => {
		const { dataRoot, store } = await makeStore();
		await store.capture({ role: "admin", state: stateWithCookie("secret") });
		const adminPaths = roleStatePaths(dataRoot);
		await writeFile(adminPaths.state, "not-json");
		const orphanPaths = roleStatePaths(dataRoot, "old-role");
		await mkdir(orphanPaths.roleDirectory);
		await writeFile(join(orphanPaths.roleDirectory, "garbage"), "secret");

		expect(await store.list()).toEqual([
			{ role: "admin", status: "invalid" },
			{ role: "customer", status: "missing" },
			{ role: "old-role", status: "orphaned" },
		]);
		await expect(store.resolve("admin")).rejects.toMatchObject({ exitCode: 2 });
		expect(await store.removableRoles()).toEqual(["admin", "old-role"]);

		await store.remove({ role: "admin" });
		await store.remove({ role: "old-role" });
		expect(await store.list()).toEqual([
			{ role: "admin", status: "missing" },
			{ role: "customer", status: "missing" },
		]);
	});

	it("rejects role-state metadata that does not match its directory identity", async () => {
		const { dataRoot, store } = await makeStore();
		await store.capture({ role: "admin", state: stateWithCookie("secret") });
		const paths = roleStatePaths(dataRoot);
		await writeFile(
			paths.metadata,
			JSON.stringify({
				origin: configuredOrigin,
				role: "customer",
				schemaVersion: 1,
			}),
		);

		expect(await store.list()).toContainEqual({
			role: "admin",
			status: "invalid",
		});
		await expect(store.resolve("admin")).rejects.toThrow(/missing or invalid/i);
		expect(await store.removableRoles()).toContain("admin");
	});

	it("reports configured symlinks and files as invalid but never selects, follows, or removes them", async () => {
		if (process.platform === "win32") return;
		const { dataRoot, store } = await makeStore(["admin", "customer"]);
		await store.capture({ role: "admin", state: stateWithCookie("secret") });
		const outside = await makeRoot();
		const customerPaths = roleStatePaths(dataRoot, "customer");
		await writeFile(join(outside, "sentinel"), "keep");
		await symlink(outside, customerPaths.roleDirectory);

		expect(await store.list()).toEqual([
			{ role: "admin", status: "ready" },
			{ role: "customer", status: "invalid" },
		]);
		expect(await store.removableRoles()).toEqual(["admin"]);
		await expect(store.resolve("customer")).rejects.toThrow(/manual cleanup/i);
		await expect(
			store.capture({ role: "customer", state: stateWithCookie("new") }),
		).rejects.toThrow(/manual cleanup/i);
		await expect(store.remove({ role: "customer" })).rejects.toThrow(
			/manual cleanup/i,
		);
		expect(await readFile(join(outside, "sentinel"), "utf8")).toBe("keep");

		await rm(customerPaths.roleDirectory);
		await writeFile(customerPaths.roleDirectory, "collision");
		expect(await store.list()).toContainEqual({
			role: "customer",
			status: "invalid",
		});
		await expect(store.remove({ role: "customer" })).rejects.toThrow(
			/manual cleanup/i,
		);
	});

	it("ignores unsafe unconfigured names and entries", async () => {
		const { dataRoot, store } = await makeStore(["admin"]);
		await store.capture({ role: "admin", state: stateWithCookie("secret") });
		const { statesDirectory } = roleStatePaths(dataRoot);
		await mkdir(join(statesDirectory, "Invalid Name"));
		await writeFile(join(statesDirectory, "old-role-file"), "secret");

		expect(await store.list()).toEqual([{ role: "admin", status: "ready" }]);
		expect(await store.removableRoles()).toEqual(["admin"]);
	});

	it("never reads or mutates the legacy profiles namespace", async () => {
		const { dataRoot, store } = await makeStore();
		await store.capture({ role: "admin", state: stateWithCookie("admin") });
		const paths = roleStatePaths(dataRoot);
		const legacyEntry = join(paths.legacyProfiles, "admin-primary");
		await mkdir(legacyEntry, { recursive: true });
		await writeFile(join(legacyEntry, "sentinel-secret"), "keep");

		await store.capture({
			role: "customer",
			state: stateWithCookie("customer"),
		});
		await store.remove({ role: "admin" });

		expect(await readFile(join(legacyEntry, "sentinel-secret"), "utf8")).toBe(
			"keep",
		);
		expect(await store.list()).toEqual([
			{ role: "admin", status: "missing" },
			{ role: "customer", status: "ready" },
		]);
	});

	it("creates the new registry beside a pre-existing legacy-only partition", async () => {
		const dataRoot = join(await makeRoot(), "data");
		const paths = roleStatePaths(dataRoot);
		const legacyEntry = join(paths.legacyProfiles, "poison-profile");
		await mkdir(legacyEntry, { recursive: true });
		await writeFile(
			join(paths.originDirectory, "origin.json"),
			JSON.stringify({ origin: configuredOrigin, schemaVersion: 1 }),
		);
		await writeFile(join(legacyEntry, "sentinel-secret"), "keep");
		const store = createRoleStateStore({
			dataRoot,
			origin: configuredOrigin,
			roles: ["admin"],
		});

		expect(await store.list()).toEqual([{ role: "admin", status: "missing" }]);
		await store.capture({ role: "admin", state: stateWithCookie("new") });

		expect(await store.list()).toEqual([{ role: "admin", status: "ready" }]);
		expect(await readFile(join(legacyEntry, "sentinel-secret"), "utf8")).toBe(
			"keep",
		);
	});

	it("preserves the previous state when refresh validation or an abort fails", async () => {
		const { store } = await makeStore(["admin"]);
		await store.capture({ role: "admin", state: stateWithCookie("previous") });

		await expect(
			store.refresh({ role: "admin", state: { cookies: [] } }),
		).rejects.toThrow(/role state is invalid/i);
		const controller = new AbortController();
		controller.abort("SIGTERM");
		await expect(
			store.refresh({
				role: "admin",
				signal: controller.signal,
				state: stateWithCookie("replacement"),
			}),
		).rejects.toMatchObject({
			exitCode: 143,
			signal: "SIGTERM",
		});
		expect((await store.resolve("admin")).state.cookies[0]?.value).toBe(
			"previous",
		);
	});

	it("cleans interrupted capture and leaves removal unchanged before commit", async () => {
		const { dataRoot, store } = await makeStore(["admin", "customer"]);
		const captureController = new AbortController();
		captureController.abort("SIGINT");

		await expect(
			store.capture({
				role: "admin",
				signal: captureController.signal,
				state: stateWithCookie("secret"),
			}),
		).rejects.toMatchObject({ exitCode: 130 });
		expect(await store.list()).toEqual([
			{ role: "admin", status: "missing" },
			{ role: "customer", status: "missing" },
		]);
		const origins = await readdir(join(dataRoot, "origins"));
		expect(origins.every((entry) => !entry.startsWith(".tmp-"))).toBe(true);

		await store.capture({ role: "admin", state: stateWithCookie("kept") });
		const removeController = new AbortController();
		removeController.abort("SIGTERM");
		await expect(
			store.remove({ role: "admin", signal: removeController.signal }),
		).rejects.toMatchObject({ exitCode: 143 });
		expect((await store.resolve("admin")).state.cookies[0]?.value).toBe("kept");
	});

	it("preserves prior bytes and cleans temporary state after write and rename failures", async () => {
		type FileSystemPromises = typeof import("node:fs/promises");
		const actual =
			await vi.importActual<FileSystemPromises>("node:fs/promises");
		let failure:
			| "origin-rename"
			| "origin-write"
			| "refresh-cleanup"
			| "refresh-cleanup-once"
			| "refresh-rename"
			| "refresh-rollback-chmod"
			| "refresh-write"
			| "role-rename"
			| "role-write"
			| undefined;
		const rawCause =
			"raw-cause bearer-secret /private/final/storage-state.json";
		let cleanupAttempts = 0;

		vi.doMock("node:fs/promises", () => ({
			...actual,
			chmod: async (
				...args: Parameters<FileSystemPromises["chmod"]>
			): ReturnType<FileSystemPromises["chmod"]> => {
				if (
					failure === "refresh-rollback-chmod" &&
					String(args[0]).includes("storage-state.json.rollback-")
				) {
					throw new Error(rawCause);
				}
				return actual.chmod(args[0], args[1]);
			},
			rename: async (
				...args: Parameters<FileSystemPromises["rename"]>
			): ReturnType<FileSystemPromises["rename"]> => {
				const source = String(args[0]);
				if (
					((failure === "refresh-rename" ||
						failure === "refresh-cleanup" ||
						failure === "refresh-cleanup-once") &&
						source.includes("storage-state.json.tmp-")) ||
					(failure === "role-rename" && source.includes(".tmp-customer-")) ||
					(failure === "origin-rename" && source.includes(".tmp-origin-"))
				) {
					throw new Error(rawCause);
				}
				return actual.rename(args[0], args[1]);
			},
			rm: async (
				...args: Parameters<FileSystemPromises["rm"]>
			): ReturnType<FileSystemPromises["rm"]> => {
				if (String(args[0]).includes("storage-state.json.tmp-")) {
					cleanupAttempts += 1;
					if (
						failure === "refresh-cleanup" ||
						(failure === "refresh-cleanup-once" && cleanupAttempts === 1)
					) {
						throw new Error(rawCause);
					}
				}
				return actual.rm(args[0], args[1]);
			},
			writeFile: async (
				...args: Parameters<FileSystemPromises["writeFile"]>
			): ReturnType<FileSystemPromises["writeFile"]> => {
				const target = String(args[0]);
				if (
					(failure === "refresh-write" &&
						target.includes("storage-state.json.tmp-")) ||
					(failure === "role-write" &&
						target.includes(".tmp-customer-") &&
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

		const { createRoleStateStore: createStoreWithMockedFileSystem } =
			await import("../src/role-states/role-state-store.js");
		const dataRoot = join(await makeRoot(), "data");
		const store = createStoreWithMockedFileSystem({
			dataRoot,
			origin: configuredOrigin,
			roles: ["admin", "customer"],
		});
		await store.capture({
			role: "admin",
			state: stateWithCookie("prior"),
		});
		const paths = roleStatePaths(dataRoot);
		const priorBytes = await readFile(paths.state);

		for (const injectedFailure of [
			"refresh-rollback-chmod",
			"refresh-write",
			"refresh-rename",
		] as const) {
			failure = injectedFailure;
			const error = await store
				.refresh({
					role: "admin",
					state: stateWithCookie("replacement"),
				})
				.catch((cause: unknown) => cause);
			expect(String(error)).toContain("previous state is unchanged");
			expect(String(error)).not.toContain("bearer-secret");
			expect(String(error)).not.toContain("storage-state.json");
			expect(await readFile(paths.state)).toEqual(priorBytes);
			expect(
				(await readdir(paths.roleDirectory)).filter((entry) =>
					entry.startsWith("storage-state.json."),
				),
			).toEqual([]);
		}

		failure = "refresh-cleanup";
		const cleanupError = await store
			.refresh({
				role: "admin",
				state: stateWithCookie("replacement"),
			})
			.catch((cause: unknown) => cause);
		expect(String(cleanupError)).toContain(
			"temporary cleanup could not complete safely",
		);
		expect(String(cleanupError)).not.toContain("bearer-secret");
		expect(await readFile(paths.state)).toEqual(priorBytes);
		for (const entry of await readdir(paths.roleDirectory)) {
			if (entry.startsWith("storage-state.json.tmp-")) {
				await actual.rm(join(paths.roleDirectory, entry), { force: true });
			}
		}

		failure = "refresh-cleanup-once";
		cleanupAttempts = 0;
		const transientCleanupError = await store
			.refresh({
				role: "admin",
				state: stateWithCookie("replacement"),
			})
			.catch((cause: unknown) => cause);
		expect(String(transientCleanupError)).toContain(
			"previous state is unchanged",
		);
		expect(cleanupAttempts).toBe(2);
		expect(await readFile(paths.state)).toEqual(priorBytes);
		expect(
			(await readdir(paths.roleDirectory)).filter((entry) =>
				entry.startsWith("storage-state.json.tmp-"),
			),
		).toEqual([]);

		for (const injectedFailure of ["role-write", "role-rename"] as const) {
			failure = injectedFailure;
			const error = await store
				.capture({
					role: "customer",
					state: stateWithCookie("not-committed"),
				})
				.catch((cause: unknown) => cause);
			expect(String(error)).toContain("Role state could not be saved");
			expect(String(error)).not.toContain("bearer-secret");
			expect(await readdir(paths.statesDirectory)).toEqual(["admin"]);
			expect(await readFile(paths.state)).toEqual(priorBytes);
		}

		for (const injectedFailure of ["origin-write", "origin-rename"] as const) {
			failure = injectedFailure;
			const freshDataRoot = join(await makeRoot(), "data");
			const freshStore = createStoreWithMockedFileSystem({
				dataRoot: freshDataRoot,
				origin: configuredOrigin,
				roles: ["admin"],
			});
			const error = await freshStore
				.capture({
					role: "admin",
					state: stateWithCookie("not-committed"),
				})
				.catch((cause: unknown) => cause);
			expect(String(error)).toContain("Role state could not be saved");
			expect(String(error)).not.toContain("bearer-secret");
			expect(await readdir(join(freshDataRoot, "origins"))).toEqual([]);
		}
	});

	it("rolls back origin, role, and refresh commits when interrupted after rename", async () => {
		type FileSystemPromises = typeof import("node:fs/promises");
		const actual =
			await vi.importActual<FileSystemPromises>("node:fs/promises");
		let abortController: AbortController | undefined;
		let abortOn: "origin" | "refresh" | "role" | undefined;

		vi.doMock("node:fs/promises", () => ({
			...actual,
			rename: async (
				...args: Parameters<FileSystemPromises["rename"]>
			): ReturnType<FileSystemPromises["rename"]> => {
				const source = String(args[0]);
				await actual.rename(args[0], args[1]);
				if (
					(abortOn === "origin" && source.includes(".tmp-origin-")) ||
					(abortOn === "role" && source.includes(".tmp-customer-")) ||
					(abortOn === "refresh" && source.includes("storage-state.json.tmp-"))
				) {
					abortController?.abort("SIGTERM");
				}
			},
		}));
		vi.resetModules();

		const { createRoleStateStore: createStoreWithMockedFileSystem } =
			await import("../src/role-states/role-state-store.js");
		const originDataRoot = join(await makeRoot(), "data");
		const originStore = createStoreWithMockedFileSystem({
			dataRoot: originDataRoot,
			origin: configuredOrigin,
			roles: ["admin"],
		});
		abortController = new AbortController();
		abortOn = "origin";
		await expect(
			originStore.capture({
				role: "admin",
				signal: abortController.signal,
				state: stateWithCookie("not-committed"),
			}),
		).rejects.toMatchObject({ exitCode: 143, signal: "SIGTERM" });
		expect(await readdir(join(originDataRoot, "origins"))).toEqual([]);

		const dataRoot = join(await makeRoot(), "data");
		const store = createStoreWithMockedFileSystem({
			dataRoot,
			origin: configuredOrigin,
			roles: ["admin", "customer"],
		});
		abortController = undefined;
		abortOn = undefined;
		await store.capture({
			role: "admin",
			state: stateWithCookie("prior"),
		});
		const paths = roleStatePaths(dataRoot);
		const priorBytes = await readFile(paths.state);

		abortController = new AbortController();
		abortOn = "role";
		await expect(
			store.capture({
				role: "customer",
				signal: abortController.signal,
				state: stateWithCookie("not-committed"),
			}),
		).rejects.toMatchObject({ exitCode: 143, signal: "SIGTERM" });
		expect(await readdir(paths.statesDirectory)).toEqual(["admin"]);

		abortController = new AbortController();
		abortOn = "refresh";
		await expect(
			store.refresh({
				role: "admin",
				signal: abortController.signal,
				state: stateWithCookie("replacement"),
			}),
		).rejects.toMatchObject({ exitCode: 143, signal: "SIGTERM" });
		expect(await readFile(paths.state)).toEqual(priorBytes);
		expect(
			(await readdir(paths.roleDirectory)).filter((entry) =>
				entry.startsWith("storage-state.json."),
			),
		).toEqual([]);
	});

	it("reports failed commit rollbacks and refresh cleanup without exposing secrets", async () => {
		type FileSystemPromises = typeof import("node:fs/promises");
		const actual =
			await vi.importActual<FileSystemPromises>("node:fs/promises");
		const rawCause = "rollback-cause bearer-secret /private/storage-state.json";
		let abortController: AbortController | undefined;
		let abortOn: "origin" | "refresh" | "role" | undefined;
		let failOn:
			| "origin-rollback"
			| "refresh-cleanup"
			| "refresh-rollback"
			| "role-rollback"
			| undefined;

		vi.doMock("node:fs/promises", () => ({
			...actual,
			rename: async (
				...args: Parameters<FileSystemPromises["rename"]>
			): ReturnType<FileSystemPromises["rename"]> => {
				const source = String(args[0]);
				if (
					failOn === "refresh-rollback" &&
					source.includes("storage-state.json.rollback-")
				) {
					throw new Error(rawCause);
				}
				if (
					failOn === "refresh-cleanup" &&
					source.includes("storage-state.json.tmp-")
				) {
					throw new Error(rawCause);
				}
				await actual.rename(args[0], args[1]);
				if (
					(abortOn === "origin" && source.includes(".tmp-origin-")) ||
					(abortOn === "role" && source.includes(".tmp-customer-")) ||
					(abortOn === "refresh" && source.includes("storage-state.json.tmp-"))
				) {
					abortController?.abort("SIGTERM");
				}
			},
			rm: async (
				...args: Parameters<FileSystemPromises["rm"]>
			): ReturnType<FileSystemPromises["rm"]> => {
				const target = String(args[0]);
				if (
					(failOn === "origin-rollback" &&
						target.includes(
							`/origins/${configuredOriginKey(configuredOrigin)}`,
						) &&
						!target.includes(".tmp-origin-")) ||
					(failOn === "role-rollback" && target.endsWith("customer")) ||
					(failOn === "refresh-cleanup" &&
						target.includes("storage-state.json.rollback-"))
				) {
					throw new Error(rawCause);
				}
				return actual.rm(args[0], args[1]);
			},
		}));
		vi.resetModules();

		const { createRoleStateStore: createStoreWithMockedFileSystem } =
			await import("../src/role-states/role-state-store.js");
		const originDataRoot = join(await makeRoot(), "data");
		const originStore = createStoreWithMockedFileSystem({
			dataRoot: originDataRoot,
			origin: configuredOrigin,
			roles: ["admin"],
		});
		abortController = new AbortController();
		abortOn = "origin";
		failOn = "origin-rollback";
		const originError = await originStore
			.capture({
				role: "admin",
				signal: abortController.signal,
				state: stateWithCookie("committed"),
			})
			.catch((cause: unknown) => cause);
		expect(String(originError)).toContain(
			"Interrupted role state save could not be rolled back safely",
		);
		expect(String(originError)).not.toContain("bearer-secret");
		expect((await originStore.resolve("admin")).state.cookies[0]?.value).toBe(
			"committed",
		);

		const roleDataRoot = join(await makeRoot(), "data");
		const roleStore = createStoreWithMockedFileSystem({
			dataRoot: roleDataRoot,
			origin: configuredOrigin,
			roles: ["admin", "customer"],
		});
		abortController = undefined;
		abortOn = undefined;
		failOn = undefined;
		await roleStore.capture({
			role: "admin",
			state: stateWithCookie("prior"),
		});
		abortController = new AbortController();
		abortOn = "role";
		failOn = "role-rollback";
		const roleError = await roleStore
			.capture({
				role: "customer",
				signal: abortController.signal,
				state: stateWithCookie("committed"),
			})
			.catch((cause: unknown) => cause);
		expect(String(roleError)).toContain(
			"Interrupted role state save could not be rolled back safely",
		);
		expect(String(roleError)).not.toContain("bearer-secret");
		expect((await roleStore.resolve("customer")).state.cookies[0]?.value).toBe(
			"committed",
		);

		const refreshDataRoot = join(await makeRoot(), "data");
		const refreshStore = createStoreWithMockedFileSystem({
			dataRoot: refreshDataRoot,
			origin: configuredOrigin,
			roles: ["admin"],
		});
		abortController = undefined;
		abortOn = undefined;
		failOn = undefined;
		await refreshStore.capture({
			role: "admin",
			state: stateWithCookie("prior"),
		});
		abortController = new AbortController();
		abortOn = "refresh";
		failOn = "refresh-rollback";
		const refreshRollbackError = await refreshStore
			.refresh({
				role: "admin",
				signal: abortController.signal,
				state: stateWithCookie("replacement"),
			})
			.catch((cause: unknown) => cause);
		expect(String(refreshRollbackError)).toContain(
			"Role state refresh rollback could not complete safely",
		);
		expect(String(refreshRollbackError)).not.toContain("bearer-secret");
		expect((await refreshStore.resolve("admin")).state.cookies[0]?.value).toBe(
			"replacement",
		);

		const cleanupDataRoot = join(await makeRoot(), "data");
		const cleanupStore = createStoreWithMockedFileSystem({
			dataRoot: cleanupDataRoot,
			origin: configuredOrigin,
			roles: ["admin"],
		});
		abortController = undefined;
		abortOn = undefined;
		failOn = undefined;
		await cleanupStore.capture({
			role: "admin",
			state: stateWithCookie("prior"),
		});
		const cleanupPaths = roleStatePaths(cleanupDataRoot);
		const priorBytes = await readFile(cleanupPaths.state);
		failOn = "refresh-cleanup";
		const refreshCleanupError = await cleanupStore
			.refresh({
				role: "admin",
				state: stateWithCookie("replacement"),
			})
			.catch((cause: unknown) => cause);
		expect(String(refreshCleanupError)).toContain(
			"Role state refresh cleanup could not complete safely",
		);
		expect(String(refreshCleanupError)).not.toContain("bearer-secret");
		expect(await readFile(cleanupPaths.state)).toEqual(priorBytes);
		expect(
			(await readdir(cleanupPaths.roleDirectory)).filter((entry) =>
				entry.startsWith("storage-state.json.rollback-"),
			),
		).toHaveLength(1);
	});

	it("keeps removal truthful across revalidation, rename, and quarantine cleanup", async () => {
		type FileSystemPromises = typeof import("node:fs/promises");
		const actual =
			await vi.importActual<FileSystemPromises>("node:fs/promises");
		const rawCause =
			"raw removal cause bearer-secret /private/storage-state.json";
		let abortController: AbortController | undefined;
		let abortDuringCleanup = false;
		let cleanupRelease: (() => void) | undefined;
		let failure:
			| "cleanup"
			| "precommit-cleanup"
			| "rename"
			| "revalidation-lstat"
			| "stale-target"
			| undefined;
		let removalCalls = 0;
		let removalOptions: Parameters<FileSystemPromises["rm"]>[1] | undefined;
		let targetLstatCalls = 0;

		vi.doMock("node:fs/promises", () => ({
			...actual,
			lstat: async (
				...args: Parameters<FileSystemPromises["lstat"]>
			): ReturnType<FileSystemPromises["lstat"]> => {
				if (
					basename(String(args[0])) === "admin" &&
					basename(dirname(String(args[0]))) === "role-states"
				) {
					targetLstatCalls += 1;
					if (failure === "revalidation-lstat" && targetLstatCalls === 2) {
						throw Object.assign(new Error(rawCause), { code: "EIO" });
					}
				}
				return actual.lstat(...args);
			},
			mkdtemp: async (
				...args: Parameters<FileSystemPromises["mkdtemp"]>
			): ReturnType<FileSystemPromises["mkdtemp"]> => {
				const temporary = await actual.mkdtemp(...args);
				if (
					failure === "stale-target" &&
					String(args[0]).includes(".tmp-remove-admin-")
				) {
					const target = String(args[0]).replace(
						/\.tmp-remove-admin-$/,
						"admin",
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
					basename(String(args[1])) === "role-state" &&
					String(args[1]).includes(".tmp-remove-admin-")
				) {
					throw new Error(rawCause);
				}
				return actual.rename(args[0], args[1]);
			},
			rm: async (
				...args: Parameters<FileSystemPromises["rm"]>
			): ReturnType<FileSystemPromises["rm"]> => {
				const target = String(args[0]);
				if (target.includes(".tmp-remove-admin-")) {
					if (basename(target) === "role-state") {
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
							await actual.writeFile(join(target, "partial-marker"), "partial");
							throw new Error(rawCause);
						}
					}
				}
				return actual.rm(args[0], args[1]);
			},
		}));
		vi.resetModules();

		const { createRoleStateStore: createStoreWithMockedFileSystem } =
			await import("../src/role-states/role-state-store.js");
		const newStore = async () => {
			failure = undefined;
			abortDuringCleanup = false;
			targetLstatCalls = 0;
			const dataRoot = join(await makeRoot(), "data");
			const store = createStoreWithMockedFileSystem({
				dataRoot,
				origin: configuredOrigin,
				roles: ["admin"],
			});
			await store.capture({
				role: "admin",
				state: stateWithCookie("bearer-secret"),
			});
			targetLstatCalls = 0;
			return { dataRoot, store };
		};

		for (const injectedFailure of ["revalidation-lstat", "rename"] as const) {
			const { dataRoot, store } = await newStore();
			failure = injectedFailure;
			const error = await store
				.remove({ role: "admin" })
				.catch((cause: unknown) => cause);
			expect(error).toMatchObject({ exitCode: 1 });
			expect(String(error)).toContain("no role state changed");
			expect(String(error)).not.toContain(rawCause);
			expect(String(error)).not.toContain("bearer-secret");
			expect(String(error)).not.toContain("storage-state.json");
			expect(await store.removableRoles()).toEqual(["admin"]);
			expect(
				(await readdir(roleStatePaths(dataRoot).statesDirectory)).filter(
					(entry) => entry.startsWith(".tmp-remove-"),
				),
			).toEqual([]);
		}

		{
			const { dataRoot, store } = await newStore();
			failure = "precommit-cleanup";
			const error = await store
				.remove({ role: "admin" })
				.catch((cause: unknown) => cause);
			expect(String(error)).toContain("preparation could not be cleaned");
			expect(String(error)).not.toContain("bearer-secret");
			expect(await store.removableRoles()).toEqual(["admin"]);
			expect(
				(await readdir(roleStatePaths(dataRoot).statesDirectory)).some(
					(entry) => entry.startsWith(".tmp-remove-admin-"),
				),
			).toBe(true);
		}

		{
			const { dataRoot, store } = await newStore();
			failure = "stale-target";
			await expect(store.remove({ role: "admin" })).rejects.toMatchObject({
				exitCode: 2,
			});
			expect(
				(await stat(roleStatePaths(dataRoot).roleDirectory)).isFile(),
			).toBe(true);
			expect(
				(await readdir(roleStatePaths(dataRoot).statesDirectory)).filter(
					(entry) => entry.startsWith(".tmp-remove-"),
				),
			).toEqual([]);
		}

		{
			const { dataRoot, store } = await newStore();
			failure = "cleanup";
			const error = await store
				.remove({ role: "admin" })
				.catch((cause: unknown) => cause);
			expect(error).toMatchObject({ exitCode: 1 });
			expect(String(error)).toContain(
				"unavailable, but local secret cleanup is incomplete",
			);
			expect(String(error)).not.toContain("bearer-secret");
			expect(await store.removableRoles()).toEqual([]);
			const quarantine = (
				await readdir(roleStatePaths(dataRoot).statesDirectory)
			).find((entry) => entry.startsWith(".tmp-remove-admin-"));
			expect(quarantine).toBeDefined();
			if (process.platform !== "win32" && quarantine) {
				expect(
					(
						await stat(
							join(roleStatePaths(dataRoot).statesDirectory, quarantine),
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

		abortController = new AbortController();
		{
			const { store } = await newStore();
			abortDuringCleanup = true;
			let settled = false;
			const removal = store
				.remove({ role: "admin", signal: abortController.signal })
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
			expect(await store.removableRoles()).toEqual([]);
		}
	});
});
