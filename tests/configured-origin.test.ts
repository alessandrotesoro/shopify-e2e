import { lstat, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
	configuredOriginKey,
	normalizeConfiguredOrigin,
	resolveProfileDataRoot,
} from "../src/profiles/configured-origin.js";

const temporaryDirectories: string[] = [];

const makeRoot = async (): Promise<string> => {
	const root = await mkdtemp(join(tmpdir(), "shopify-e2e-profiles-"));
	temporaryDirectories.push(root);
	return realpath(root);
};

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

describe("configured origin", () => {
	it("normalizes only an absolute HTTPS origin", () => {
		expect(
			normalizeConfiguredOrigin(
				"https://Example.COM/store?secret=value#fragment",
			),
		).toBe("https://example.com");
		expect(() => normalizeConfiguredOrigin("http://example.com")).toThrow(
			/HTTPS/i,
		);
		expect(() =>
			normalizeConfiguredOrigin("https://user:secret@example.com"),
		).toThrow(/credentials|userinfo/i);
		expect(() => normalizeConfiguredOrigin("shop.example")).toThrow(
			/absolute HTTPS/i,
		);
		expect(
			normalizeConfiguredOrigin("https://EXAMPLE.com:443/a/b?token=x#section"),
		).toBe("https://example.com");
	});

	it("partitions custom and myshopify origins independently", () => {
		expect(configuredOriginKey("https://shop.example")).not.toBe(
			configuredOriginKey("https://shop.myshopify.com"),
		);
		expect(configuredOriginKey("https://shop.example")).toMatch(
			/^[a-f0-9]{64}$/,
		);
	});

	it("accepts safe roots and rejects existing and prospective roots inside a consumer or package", async () => {
		const projectRoot = await makeRoot();
		const packageRoot = await makeRoot();
		const safeRoot = await makeRoot();
		const prospectiveSafeRoot = join(safeRoot, "future", "data");

		await expect(
			resolveProfileDataRoot({
				dataDir: prospectiveSafeRoot,
				packageRoot,
				projectRoot,
			}),
		).resolves.toBe(prospectiveSafeRoot);

		const consumerCandidate = join(projectRoot, "existing-data");
		await expect(
			resolveProfileDataRoot({
				dataDir: consumerCandidate,
				packageRoot,
				projectRoot,
			}),
		).rejects.toThrow(/outside/i);
		await expect(lstat(consumerCandidate)).rejects.toThrow();

		const packageCandidate = join(packageRoot, "future", "nested");
		await expect(
			resolveProfileDataRoot({
				dataDir: packageCandidate,
				packageRoot,
				projectRoot,
			}),
		).rejects.toThrow(/outside/i);
		await expect(lstat(packageCandidate)).rejects.toThrow();
	});

	it("rejects relative roots and roots containing symlink components", async () => {
		const projectRoot = await makeRoot();
		const packageRoot = await makeRoot();
		const linkParent = await makeRoot();
		const linkTarget = await makeRoot();

		await expect(
			resolveProfileDataRoot({
				dataDir: "relative/data",
				packageRoot,
				projectRoot,
			}),
		).rejects.toThrow(/absolute/i);

		if (process.platform !== "win32") {
			await symlink(linkTarget, join(linkParent, "linked"));
			await expect(
				resolveProfileDataRoot({
					dataDir: join(linkParent, "linked", "data"),
					packageRoot,
					projectRoot,
				}),
			).rejects.toThrow(/symbolic/i);
		}
	});
});
