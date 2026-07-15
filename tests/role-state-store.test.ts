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
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { configuredOriginKey } from "../src/role-states/configured-origin.cjs";
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
		expect(await store.readyRoles()).toEqual(["admin"]);
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

		expect(await store.readyRoles()).toEqual(["admin"]);
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
});
