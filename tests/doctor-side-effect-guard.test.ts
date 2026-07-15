import { spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const guardPath = resolve(
	import.meta.dirname,
	"fixtures/doctor-side-effect-guard.cjs",
);
const temporaryDirectories: string[] = [];

const runWithGuard = async (
	makeScript: (directory: string) => string,
	allowedNames: readonly string[] = [],
) => {
	const directory = await mkdtemp(join(tmpdir(), "shopify-e2e-doctor-guard-"));
	temporaryDirectories.push(directory);
	const activeMarker = join(directory, "guard-active.marker");
	const allowedPaths = allowedNames.map((name) => join(directory, name));
	const result = spawnSync(
		process.execPath,
		["--require", guardPath, "--eval", makeScript(directory)],
		{
			encoding: "utf8",
			env: {
				...process.env,
				SHOPIFY_E2E_SIDE_EFFECT_GUARD_ACTIVE_MARKER: activeMarker,
				SHOPIFY_E2E_WRITE_ALLOWLIST: JSON.stringify(allowedPaths),
			},
		},
	);
	await expect(access(activeMarker)).resolves.toBeUndefined();
	return { directory, result };
};

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

describe("doctor side-effect guard", () => {
	it("allows an explicitly allowlisted marker write", async () => {
		const { directory, result } = await runWithGuard(
			(directory) =>
				`require("node:fs").writeFileSync(${JSON.stringify(join(directory, "allowed.marker"))}, "allowed\\n")`,
			["allowed.marker"],
		);

		expect(result.status, result.stderr).toBe(0);
		await expect(
			readFile(join(directory, "allowed.marker"), "utf8"),
		).resolves.toBe("allowed\n");
	});

	it("rejects a filesystem write outside the allowlist", async () => {
		const { directory, result } = await runWithGuard(
			(directory) =>
				`require("node:fs").writeFileSync(${JSON.stringify(join(directory, "forbidden.marker"))}, "written")`,
		);

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain(
			"doctor test blocked package-owned side effect: writeFileSync",
		);
		await expect(access(join(directory, "forbidden.marker"))).rejects.toThrow();
	});

	it("rejects a direct socket connection", async () => {
		const { result } = await runWithGuard(
			() =>
				'new (require("node:net").Socket)().connect({ host: "127.0.0.1", port: 9 })',
		);

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain(
			"doctor test blocked package-owned side effect: connect",
		);
	});
});
