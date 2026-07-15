import { spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	cleanupInstalledCliFixture,
	doctorIsolationMarkers,
	expectMarkersAbsent,
	generatedConfigDirectories,
	type InstalledDoctorCliFixture,
	makeTemporaryDirectory,
	prepareInstalledDoctorCliFixture,
} from "./support/installed-cli-harness.js";
import { installedCliPath } from "./support/installed-consumer.js";

const projectRoot = resolve(import.meta.dirname, "..");
const fixtureRoot = resolve(import.meta.dirname, "fixtures/consumer");

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
	readonly profilePoisonPath: string;
	readonly result: CommandResult;
}

const runInstalledDoctor = ({
	consumerRoot,
	markerDirectory,
}: RunInstalledDoctorArgs): InstalledDoctorResult => {
	const profilePoisonPath = join(
		consumerRoot,
		"doctor-must-not-create-profile-data",
	);
	const command = spawnSync(installedCliPath(consumerRoot), ["doctor"], {
		cwd: consumerRoot,
		encoding: "utf8",
		env: {
			...process.env,
			NO_COLOR: "1",
			SHOPIFY_E2E_DATA_DIR: profilePoisonPath,
			SHOPIFY_E2E_MARKER_DIR: markerDirectory,
			SHOPIFY_STORE_URL: "https://shop.example",
		},
		killSignal: "SIGKILL",
		maxBuffer: 10 * 1024 * 1024,
		timeout: 30_000,
	});
	return {
		profilePoisonPath,
		result: {
			...(command.error === undefined ? {} : { error: command.error }),
			status: command.status,
			stderr: command.stderr,
			stdout: command.stdout,
		},
	};
};

const expectDoctorIsolation = async ({
	markerDirectory,
	profilePoisonPath,
}: {
	readonly markerDirectory: string;
	readonly profilePoisonPath: string;
}): Promise<void> => {
	await expectMarkersAbsent({
		markerDirectory,
		names: doctorIsolationMarkers,
	});
	await expect(access(profilePoisonPath)).rejects.toMatchObject({
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
		const generatedBefore = await generatedConfigDirectories(
			fixture.ready.consumerRoot,
		);
		const { profilePoisonPath, result } = runInstalledDoctor({
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
			expect.stringMatching(/^PASS Shopify spec candidates:/),
			expect.stringMatching(/^PASS Playwright peer:/),
			expect.stringMatching(/^PASS Chromium:/),
		]);
		await expect(access(fixture.ready.launchMarker)).rejects.toMatchObject({
			code: "ENOENT",
		});
		await expect(
			generatedConfigDirectories(fixture.ready.consumerRoot),
		).resolves.toEqual(generatedBefore);
		await expectDoctorIsolation({ markerDirectory, profilePoisonPath });
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

		const { profilePoisonPath, result } = runInstalledDoctor({
			consumerRoot: fixture.missingPeerConsumerRoot,
			markerDirectory,
		});

		expect(result.status).toBe(2);
		expect(result.stdout).toMatch(/^FAIL Playwright peer:/m);
		expect(result.stdout).toMatch(/^SKIP Chromium:/m);
		expect(result.stdout).not.toMatch(/^PASS Playwright peer:/m);
		await expectDoctorIsolation({ markerDirectory, profilePoisonPath });
	});

	it("reports packed missing Chromium with install guidance and no launch", async () => {
		const { profilePoisonPath, result } = runInstalledDoctor({
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
		await expectDoctorIsolation({ markerDirectory, profilePoisonPath });
	});
});
