import { spawnSync } from "node:child_process";
import { access, mkdir, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	cleanupInstalledCliFixture,
	doctorIsolationMarkers,
	expectMarkersAbsent,
	type InstalledDoctorCliFixture,
	makeTemporaryDirectory,
	prepareInstalledDoctorCliFixture,
} from "./support/installed-cli-harness.js";
import { installedCliPath } from "./support/installed-consumer.js";

const projectRoot = resolve(import.meta.dirname, "..");
const fixtureRoot = resolve(import.meta.dirname, "fixtures/consumer");
const sideEffectGuardPath = resolve(
	import.meta.dirname,
	"fixtures/doctor-side-effect-guard.cjs",
);

interface CommandResult {
	readonly error?: Error;
	readonly status: number | null;
	readonly stderr: string;
	readonly stdout: string;
}

interface RunInstalledDoctorArgs {
	readonly consumerRoot: string;
	readonly markerDirectory: string;
}

interface InstalledDoctorResult {
	readonly result: CommandResult;
	readonly roleStatePoisonPath: string;
	readonly runtimeTemporaryRoot: string;
	readonly sideEffectGuardActiveMarker: string;
}

const runInstalledDoctor = async ({
	consumerRoot,
	markerDirectory,
}: RunInstalledDoctorArgs): Promise<InstalledDoctorResult> => {
	const roleStatePoisonPath = join(
		consumerRoot,
		"doctor-must-not-create-role-state-data",
	);
	const runtimeTemporaryRoot = join(consumerRoot, "doctor-runtime-tmp");
	const launchMarker = join(consumerRoot, "doctor-launch.marker");
	const sideEffectGuardActiveMarker = join(
		markerDirectory,
		`doctor-side-effect-guard-${basename(consumerRoot)}.marker`,
	);
	await mkdir(runtimeTemporaryRoot, { recursive: true });
	const command = spawnSync(installedCliPath(consumerRoot), ["doctor"], {
		cwd: consumerRoot,
		encoding: "utf8",
		env: {
			...process.env,
			NO_COLOR: "1",
			NODE_OPTIONS: `--require ${JSON.stringify(sideEffectGuardPath)}`,
			SHOPIFY_E2E_DATA_DIR: roleStatePoisonPath,
			SHOPIFY_E2E_MARKER_DIR: markerDirectory,
			SHOPIFY_E2E_SIDE_EFFECT_GUARD_ACTIVE_MARKER: sideEffectGuardActiveMarker,
			SHOPIFY_STORE_URL: "https://shop.example",
			SHOPIFY_E2E_WRITE_ALLOWLIST: JSON.stringify([
				...doctorIsolationMarkers.map((name) => join(markerDirectory, name)),
				launchMarker,
			]),
			TEMP: runtimeTemporaryRoot,
			TMP: runtimeTemporaryRoot,
			TMPDIR: runtimeTemporaryRoot,
		},
		killSignal: "SIGKILL",
		maxBuffer: 10 * 1024 * 1024,
		timeout: 30_000,
	});
	return {
		result: {
			...(command.error === undefined ? {} : { error: command.error }),
			status: command.status,
			stderr: command.stderr,
			stdout: command.stdout,
		},
		roleStatePoisonPath,
		runtimeTemporaryRoot,
		sideEffectGuardActiveMarker,
	};
};

const expectDoctorIsolation = async ({
	markerDirectory,
	roleStatePoisonPath,
	sideEffectGuardActiveMarker,
}: {
	readonly markerDirectory: string;
	readonly roleStatePoisonPath: string;
	readonly sideEffectGuardActiveMarker: string;
}): Promise<void> => {
	await expect(access(sideEffectGuardActiveMarker)).resolves.toBeUndefined();
	await expectMarkersAbsent({
		markerDirectory,
		names: doctorIsolationMarkers,
	});
	await expect(access(roleStatePoisonPath)).rejects.toMatchObject({
		code: "ENOENT",
	});
};

describe.sequential("installed doctor CLI release boundary", () => {
	let fixture: InstalledDoctorCliFixture;
	let markerDirectory = "";

	beforeAll(async () => {
		fixture = await prepareInstalledDoctorCliFixture({
			fixtureRoot,
			projectRoot,
		});
		markerDirectory = await makeTemporaryDirectory(
			"shopify-e2e-doctor-markers-",
		);
	}, 240_000);

	afterAll(cleanupInstalledCliFixture);

	it("proves packed doctor readiness without forbidden side effects", async () => {
		const {
			result,
			roleStatePoisonPath,
			runtimeTemporaryRoot,
			sideEffectGuardActiveMarker,
		} = await runInstalledDoctor({
			consumerRoot: fixture.ready.consumerRoot,
			markerDirectory,
		});

		expect(
			result.status,
			`installed ready doctor failed\n${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}`,
		).toBe(0);
		expect(
			result.stdout
				.split("\n")
				.filter((line) => /^(?:PASS|FAIL|ERROR|SKIP) /.test(line)),
		).toEqual([
			expect.stringMatching(/^PASS Project:/),
			expect.stringMatching(/^PASS Environment:/),
			expect.stringMatching(/^PASS Store URL:/),
			expect.stringMatching(/^PASS Shopify config:/),
			expect.stringMatching(/^PASS Shopify test directory:/),
			expect.stringMatching(/^PASS Playwright peer:/),
			expect.stringMatching(/^PASS Chromium:/),
		]);
		expect(result.stdout).toContain(
			"Package-owned Shopify config checks passed",
		);
		expect(result.stdout).toMatch(
			/JavaScript\/TypeScript file candidate\(s\) found/,
		);
		expect(result.stdout).not.toMatch(/runnable Playwright specs/i);
		await expect(access(fixture.ready.launchMarker)).rejects.toMatchObject({
			code: "ENOENT",
		});
		await expect(readdir(runtimeTemporaryRoot)).resolves.toEqual([]);
		await expectDoctorIsolation({
			markerDirectory,
			roleStatePoisonPath,
			sideEffectGuardActiveMarker,
		});
	});

	it("reports a missing packed consumer peer without package fallback", async () => {
		await expect(
			access(
				join(
					fixture.missingPeerConsumerRoot,
					"node_modules",
					"@playwright",
					"test",
				),
			),
		).rejects.toMatchObject({ code: "ENOENT" });

		const { result, roleStatePoisonPath, sideEffectGuardActiveMarker } =
			await runInstalledDoctor({
				consumerRoot: fixture.missingPeerConsumerRoot,
				markerDirectory,
			});

		expect(result.status).toBe(2);
		expect(result.stdout).toMatch(/^FAIL Playwright peer:/m);
		expect(result.stdout).toMatch(/^SKIP Chromium:/m);
		expect(result.stdout).not.toMatch(/^PASS Playwright peer:/m);
		await expectDoctorIsolation({
			markerDirectory,
			roleStatePoisonPath,
			sideEffectGuardActiveMarker,
		});
	});

	it("reports packed missing Chromium with install guidance and no launch", async () => {
		const { result, roleStatePoisonPath, sideEffectGuardActiveMarker } =
			await runInstalledDoctor({
				consumerRoot: fixture.missingChromium.consumerRoot,
				markerDirectory,
			});

		expect(result.status).toBe(2);
		expect(result.stdout).toMatch(/^PASS Playwright peer:/m);
		expect(result.stdout).toMatch(/^FAIL Chromium:/m);
		expect(result.stdout).toMatch(/npx playwright install chromium/i);
		await expect(
			access(fixture.missingChromium.launchMarker),
		).rejects.toMatchObject({ code: "ENOENT" });
		await expectDoctorIsolation({
			markerDirectory,
			roleStatePoisonPath,
			sideEffectGuardActiveMarker,
		});
	});
});
