import {
	mkdir,
	mkdtemp,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as dotenv from "dotenv";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadEnvironment } from "../src/environment/load-environment.js";
import { ShopifyE2EPreflightError } from "../src/errors.js";

vi.mock("dotenv", async (importOriginal) => {
	const original = await importOriginal<typeof import("dotenv")>();
	return { ...original, configDotenv: vi.fn(original.configDotenv) };
});

const temporaryDirectories: string[] = [];

const makeProject = async (): Promise<string> => {
	const project = await mkdtemp(join(tmpdir(), "shopify-e2e-environment-"));
	temporaryDirectories.push(project);
	return realpath(project);
};

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

describe("consumer environment loading", () => {
	it("loads recognized assignments from exactly the physical cwd .env without output", async () => {
		const project = await makeProject();
		await writeFile(
			join(project, ".env"),
			"SHOPIFY_STORE_URL=https://example.myshopify.com\nQUOTED_VALUE='quoted value'\n",
		);
		const environment: NodeJS.ProcessEnv = {};
		const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const stderr = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);

		await loadEnvironment({ cwd: project, environment });

		expect(environment).toEqual({
			QUOTED_VALUE: "quoted value",
			SHOPIFY_STORE_URL: "https://example.myshopify.com",
		});
		expect(stdout).not.toHaveBeenCalled();
		expect(stderr).not.toHaveBeenCalled();
	});

	it("keeps inherited dotenv controls inert while preserving them", async () => {
		const project = await makeProject();
		await writeFile(join(project, ".env"), "LOADED_VALUE=from-file\n");
		const environment: NodeJS.ProcessEnv = {
			DOTENV_CONFIG_DEBUG: "1",
			DOTENV_CONFIG_QUIET: "false",
		};
		const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const stderr = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);

		await loadEnvironment({ cwd: project, environment });

		expect(environment).toEqual({
			DOTENV_CONFIG_DEBUG: "1",
			DOTENV_CONFIG_QUIET: "false",
			LOADED_VALUE: "from-file",
		});
		expect(stdout).not.toHaveBeenCalled();
		expect(stderr).not.toHaveBeenCalled();
	});

	it("loads file-defined dotenv controls without activating them", async () => {
		const project = await makeProject();
		await writeFile(
			join(project, ".env"),
			"DOTENV_CONFIG_DEBUG=1\nDOTENV_CONFIG_QUIET=false\nLOADED_VALUE=from-file\n",
		);
		const environment: NodeJS.ProcessEnv = {};
		const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const stderr = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);

		await loadEnvironment({ cwd: project, environment });

		expect(environment).toEqual({
			DOTENV_CONFIG_DEBUG: "1",
			DOTENV_CONFIG_QUIET: "false",
			LOADED_VALUE: "from-file",
		});
		expect(stdout).not.toHaveBeenCalled();
		expect(stderr).not.toHaveBeenCalled();
	});

	it("resolves a symlinked cwd before selecting .env", async () => {
		const project = await makeProject();
		const links = await makeProject();
		const linkedCwd = join(links, "consumer");
		await symlink(project, linkedCwd, "dir");
		await writeFile(join(project, ".env"), "FROM_PHYSICAL_CWD=loaded\n");
		const environment: NodeJS.ProcessEnv = {};

		await loadEnvironment({ cwd: linkedCwd, environment });

		expect(environment).toEqual({ FROM_PHYSICAL_CWD: "loaded" });
	});

	it("preserves inherited non-empty and empty values", async () => {
		const project = await makeProject();
		await writeFile(
			join(project, ".env"),
			"EXISTING=from-file\nEXISTING_EMPTY=from-file\nNEW_VALUE=loaded\n",
		);
		const environment: NodeJS.ProcessEnv = {
			EXISTING: "from-shell",
			EXISTING_EMPTY: "",
		};

		await loadEnvironment({ cwd: project, environment });

		expect(environment).toEqual({
			EXISTING: "from-shell",
			EXISTING_EMPTY: "",
			NEW_VALUE: "loaded",
		});
	});

	it("uses standard permissive parsing for duplicate keys and malformed lines", async () => {
		const project = await makeProject();
		await writeFile(
			join(project, ".env"),
			"DUPLICATE=first\nthis is not an assignment\nDUPLICATE=last\nVALID=kept\n",
		);
		const environment: NodeJS.ProcessEnv = {};

		await loadEnvironment({ cwd: project, environment });

		expect(environment).toEqual({ DUPLICATE: "last", VALID: "kept" });
	});

	it("treats a missing cwd .env as a silent no-op", async () => {
		const project = await makeProject();
		const environment: NodeJS.ProcessEnv = { EXISTING: "kept" };
		const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const stderr = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);

		await expect(
			loadEnvironment({ cwd: project, environment }),
		).resolves.toBeUndefined();
		expect(environment).toEqual({ EXISTING: "kept" });
		expect(stdout).not.toHaveBeenCalled();
		expect(stderr).not.toHaveBeenCalled();
	});

	it("ignores parent, .env.local, and config-sibling environment files", async () => {
		const parent = await makeProject();
		const project = join(parent, "consumer");
		await mkdir(join(project, "configs"), { recursive: true });
		await writeFile(join(parent, ".env"), "FROM_PARENT=wrong\n");
		await writeFile(join(project, ".env.local"), "FROM_LOCAL=wrong\n");
		await writeFile(
			join(project, "configs", ".env"),
			"FROM_CONFIG_SIBLING=wrong\n",
		);
		const environment: NodeJS.ProcessEnv = {};

		await loadEnvironment({ cwd: project, environment });

		expect(environment).toEqual({});
	});

	it("turns non-ENOENT read failures into a sanitized preflight error", async () => {
		const project = await makeProject();
		await mkdir(join(project, ".env"));
		const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const stderr = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);

		const promise = loadEnvironment({
			cwd: project,
			environment: {
				DOTENV_CONFIG_DEBUG: "1",
				DOTENV_CONFIG_QUIET: "false",
			},
		});

		await expect(promise).rejects.toBeInstanceOf(ShopifyE2EPreflightError);
		await expect(promise).rejects.toThrow("Consumer .env could not be read");
		await expect(promise).rejects.not.toThrow(project);
		expect(stdout).not.toHaveBeenCalled();
		expect(stderr).not.toHaveBeenCalled();
	});

	it("checks the ENOENT code instead of trusting an error message", async () => {
		const project = await makeProject();
		const misleadingError = Object.assign(
			new Error("ENOENT: no such file or directory"),
			{ code: "EACCES" },
		);
		vi.mocked(dotenv.configDotenv).mockReturnValueOnce({
			error: misleadingError as NonNullable<
				ReturnType<typeof dotenv.configDotenv>["error"]
			>,
		});

		await expect(
			loadEnvironment({ cwd: project, environment: {} }),
		).rejects.toThrow("Consumer .env could not be read");
	});
});
