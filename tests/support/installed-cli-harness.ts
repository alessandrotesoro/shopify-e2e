import type { ChildProcess } from "node:child_process";
import {
	access,
	chmod,
	cp,
	mkdir,
	mkdtemp,
	readdir,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { expect } from "vitest";

import { configuredOriginKey } from "../../src/profiles/configured-origin.js";
import {
	installPackedPackage,
	packPackageForConsumer,
} from "./installed-consumer.js";

const generatedConfigPrefix = "shopify-e2e-playwright-";
const temporaryDirectories: string[] = [];

export interface InstalledCliFixture {
	readonly consumerRoot: string;
	readonly doctorMissingChromiumConsumerRoot: string;
	readonly doctorMissingChromiumLaunchMarker: string;
	readonly doctorReadyConsumerRoot: string;
	readonly doctorReadyLaunchMarker: string;
	readonly missingPeerConsumerRoot: string;
	readonly profileDataRoot: string;
	readonly removal: InstalledRemovalFixture;
}

export interface InstalledRemovalFixture {
	readonly currentOriginDirectory: string;
	readonly currentProfileDirectory: string;
	readonly currentSiblingProfileDirectories: readonly string[];
	readonly otherOriginDirectory: string;
	readonly otherOriginProfileDirectory: string;
	readonly profileName: string;
}

interface PrepareInstalledCliFixtureOptions {
	readonly fixtureRoot: string;
	readonly projectRoot: string;
}

interface SeedProfileArgs {
	readonly dataRoot: string;
	readonly name: string;
	readonly origin: string;
	readonly role: string;
	readonly state?: {
		readonly cookies: readonly Record<string, unknown>[];
		readonly origins: readonly Record<string, unknown>[];
	};
}

interface PrepareDoctorConsumerArgs {
	readonly chromiumInstalled: boolean;
	readonly fixtureRoot: string;
	readonly tarballPath: string;
}

interface MarkerArgs {
	readonly markerDirectory: string;
	readonly name: string;
}

interface ExpectMarkersAbsentArgs {
	readonly markerDirectory: string;
	readonly names: readonly string[];
}

interface WaitForMarkerArgs extends MarkerArgs {
	readonly timeoutMs: number;
}

interface WaitForProcessToExitArgs {
	readonly pid: number;
	readonly timeoutMs: number;
}

interface WaitForChildToExitArgs {
	readonly child: ChildProcess;
	readonly timeoutMs: number;
}

interface SignalProcessArgs {
	readonly pid: number;
	readonly signal: NodeJS.Signals;
}

interface TerminateAndAwaitProcessesArgs {
	readonly child: ChildProcess;
	readonly descendantPids: readonly number[];
}

const installedStateProbe = `import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { test } from "@playwright/test";

const mark = (name: string): void => {
  const markerDirectory = process.env.SHOPIFY_E2E_MARKER_DIR;
  if (!markerDirectory) throw new Error("SHOPIFY_E2E_MARKER_DIR is required");
  writeFileSync(join(markerDirectory, name + ".marker"), "verified");
};

test(
  "generated saved state is embedded by value",
  { tag: ["@shopify-e2e-role-admin", "@shopify-e2e-role-customer"] },
  ({}, testInfo) => {
    const expected = process.env.SHOPIFY_E2E_STATE_EXPECTED;
    test.skip(!expected, "installed state probe is opt-in");
    const state = testInfo.project.use.storageState;
    if (typeof state !== "object" || state === null || Array.isArray(state)) {
      throw new Error("saved state was not embedded as an object");
    }
    const expectedState = {
      cookies: [
        {
          domain: "shop.example",
          expires: -1,
          httpOnly: true,
          name: "installed-profile-sentinel",
          path: "/",
          sameSite: "Lax",
          secure: true,
          value: expected,
        },
      ],
      origins: [
        {
          localStorage: [{ name: "installed-profile-sentinel", value: expected }],
          origin: "https://shop.example",
        },
      ],
    };
    if (JSON.stringify(state) !== JSON.stringify(expectedState)) {
      throw new Error("selected profile state did not match");
    }
    const registryRoot = process.env.SHOPIFY_E2E_PROFILE_DATA_ROOT_EXPECTED;
    if (!registryRoot || process.argv.some((argument) => argument.includes(registryRoot))) {
      throw new Error("profile registry path leaked to Playwright argv");
    }
    mark("saved-state-" + expected);
  },
);

test(
  "generated guest state is explicitly empty",
  { tag: "@shopify-e2e-role-guest" },
  ({}, testInfo) => {
    test.skip(
      process.env.SHOPIFY_E2E_EMPTY_STATE_PROBE !== "1",
      "installed empty-state probe is opt-in",
    );
    const state = testInfo.project.use.storageState;
    if (
      typeof state !== "object" ||
      state === null ||
      Array.isArray(state) ||
      state.cookies.length !== 0 ||
      state.origins.length !== 0
    ) {
      throw new Error("guest state was not explicitly empty");
    }
    const registryRoot = process.env.SHOPIFY_E2E_PROFILE_DATA_ROOT_EXPECTED;
    if (!registryRoot || process.argv.some((argument) => argument.includes(registryRoot))) {
      throw new Error("profile registry path leaked to Playwright argv");
    }
    mark("guest-empty-state");
  },
);
`;

export const makeTemporaryDirectory = async (
	prefix: string,
): Promise<string> => {
	const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
	temporaryDirectories.push(directory);
	return directory;
};

const seedProfile = async ({
	dataRoot,
	name,
	origin,
	role,
	state = { cookies: [], origins: [] },
}: SeedProfileArgs): Promise<void> => {
	const originDirectory = join(
		dataRoot,
		"origins",
		configuredOriginKey(origin),
	);
	const profileDirectory = join(originDirectory, "profiles", name);
	await mkdir(profileDirectory, { mode: 0o700, recursive: true });
	await chmod(dataRoot, 0o700);
	await chmod(join(dataRoot, "origins"), 0o700);
	await chmod(originDirectory, 0o700);
	await chmod(join(originDirectory, "profiles"), 0o700);
	await chmod(profileDirectory, 0o700);
	await writeFile(
		join(originDirectory, "origin.json"),
		`${JSON.stringify({ origin, schemaVersion: 1 })}\n`,
		{ mode: 0o600 },
	);
	await writeFile(
		join(profileDirectory, "profile.json"),
		`${JSON.stringify({ name, origin, role, schemaVersion: 1 })}\n`,
		{ mode: 0o600 },
	);
	await writeFile(
		join(profileDirectory, "storage-state.json"),
		`${JSON.stringify(state)}\n`,
		{ mode: 0o600 },
	);
};

const prepareDoctorConsumer = async ({
	chromiumInstalled,
	fixtureRoot,
	tarballPath,
}: PrepareDoctorConsumerArgs): Promise<{
	readonly consumerRoot: string;
	readonly launchMarker: string;
}> => {
	const consumerRoot = await makeTemporaryDirectory(
		chromiumInstalled
			? "shopify-e2e-doctor-ready-"
			: "shopify-e2e-doctor-missing-chromium-",
	);
	await cp(fixtureRoot, consumerRoot, { recursive: true });
	await installPackedPackage({
		consumerRoot,
		hasPlaywright: false,
		tarballPath,
	});

	const peerRoot = join(consumerRoot, "node_modules", "@playwright", "test");
	const chromiumPath = join(consumerRoot, "controlled-chromium");
	const launchMarker = join(consumerRoot, "doctor-launch.marker");
	await mkdir(peerRoot, { recursive: true });
	await writeFile(
		join(peerRoot, "package.json"),
		`${JSON.stringify(
			{
				bin: { playwright: "cli.js" },
				main: "index.js",
				name: "@playwright/test",
				type: "module",
				version: "1.61.1",
			},
			null,
			2,
		)}\n`,
	);
	await writeFile(
		join(peerRoot, "cli.js"),
		"// Controlled doctor fixture CLI.\n",
	);
	await writeFile(
		join(peerRoot, "index.js"),
		`import { writeFile } from "node:fs/promises";

export const chromium = {
  executablePath: () => ${JSON.stringify(chromiumPath)},
  launch: async () => {
    await writeFile(${JSON.stringify(launchMarker)}, "launch attempted\\n");
    throw new Error("doctor must not launch Chromium");
  },
};
`,
	);
	if (chromiumInstalled) {
		await writeFile(chromiumPath, "controlled Chromium fixture\n");
	}

	return { consumerRoot, launchMarker };
};

export const prepareInstalledCliFixture = async ({
	fixtureRoot,
	projectRoot,
}: PrepareInstalledCliFixtureOptions): Promise<InstalledCliFixture> => {
	const packDirectory = await makeTemporaryDirectory("shopify-e2e-pack-");
	const packedArtifact = await packPackageForConsumer(
		projectRoot,
		packDirectory,
	);
	const tarballPath = packedArtifact.tarballPath;
	expect(basename(tarballPath)).toMatch(/^sematico-shopify-e2e-.*\.tgz$/);
	const publishedPaths = packedArtifact.files.map((file) => file.path);
	expect(publishedPaths).toEqual(
		expect.arrayContaining([
			"LICENSE",
			"README.md",
			"bin/run.js",
			"dist/commands.js",
			"dist/commands/auth.js",
			"dist/commands/auth/remove.js",
			"dist/commands/doctor.js",
			"dist/commands/run.js",
			"dist/doctor/doctor-orchestrator.js",
			"package.json",
		]),
	);
	expect(
		publishedPaths.every((path) =>
			/^(?:LICENSE|README\.md|package\.json|bin\/|dist\/)/.test(path),
		),
	).toBe(true);
	expect(
		publishedPaths.some((path) =>
			/^(?:profiles|src|tests)(?:\/|$)|(?:^|\/)\.env(?:\.|$)|shopify-e2e-playwright-|\.marker$/.test(
				path,
			),
		),
	).toBe(false);
	const executable = packedArtifact.files.find(
		(file) => file.path === "bin/run.js",
	);
	expect((executable?.mode ?? 0) & 0o111).not.toBe(0);

	const consumerRoot = await makeTemporaryDirectory("shopify-e2e-consumer-");
	await cp(fixtureRoot, consumerRoot, { recursive: true });
	await writeFile(
		join(consumerRoot, "shopify-passing", "installed-state-probe.spec.ts"),
		installedStateProbe,
	);
	await installPackedPackage({
		consumerRoot,
		hasPlaywright: true,
		tarballPath,
	});
	const doctorReady = await prepareDoctorConsumer({
		chromiumInstalled: true,
		fixtureRoot,
		tarballPath,
	});
	const doctorMissingChromium = await prepareDoctorConsumer({
		chromiumInstalled: false,
		fixtureRoot,
		tarballPath,
	});
	const profileDataRoot = await makeTemporaryDirectory(
		"shopify-e2e-profile-data-",
	);
	const currentOrigin = "https://shop.example";
	const currentProfiles = [
		["admin-primary", "admin"],
		["customer-primary", "customer"],
	] as const;
	for (const [name, role] of currentProfiles) {
		await seedProfile({
			dataRoot: profileDataRoot,
			name,
			origin: currentOrigin,
			role,
			state: {
				cookies: [
					{
						domain: "shop.example",
						expires: -1,
						httpOnly: true,
						name: "installed-profile-sentinel",
						path: "/",
						sameSite: "Lax",
						secure: true,
						value: name,
					},
				],
				origins: [
					{
						localStorage: [
							{
								name: "installed-profile-sentinel",
								value: name,
							},
						],
						origin: "https://shop.example",
					},
				],
			},
		});
	}
	const removalProfileName = "removal-disposable";
	const otherOrigin = "https://other-shop.example";
	await seedProfile({
		dataRoot: profileDataRoot,
		name: removalProfileName,
		origin: currentOrigin,
		role: "customer",
	});
	await seedProfile({
		dataRoot: profileDataRoot,
		name: removalProfileName,
		origin: otherOrigin,
		role: "customer",
	});
	const currentOriginDirectory = join(
		profileDataRoot,
		"origins",
		configuredOriginKey(currentOrigin),
	);
	const otherOriginDirectory = join(
		profileDataRoot,
		"origins",
		configuredOriginKey(otherOrigin),
	);
	const removal: InstalledRemovalFixture = {
		currentOriginDirectory,
		currentProfileDirectory: join(
			currentOriginDirectory,
			"profiles",
			removalProfileName,
		),
		currentSiblingProfileDirectories: currentProfiles.map(([name]) =>
			join(currentOriginDirectory, "profiles", name),
		),
		otherOriginDirectory,
		otherOriginProfileDirectory: join(
			otherOriginDirectory,
			"profiles",
			removalProfileName,
		),
		profileName: removalProfileName,
	};

	const missingPeerConsumerRoot = await makeTemporaryDirectory(
		"shopify-e2e-missing-peer-",
	);
	await writeFile(
		join(missingPeerConsumerRoot, "package.json"),
		'{"name":"missing-peer-consumer","private":true,"type":"module"}\n',
	);
	await cp(
		join(fixtureRoot, "shopify-e2e.config.ts"),
		join(missingPeerConsumerRoot, "shopify-e2e.config.ts"),
	);
	await cp(
		join(fixtureRoot, "shopify-passing"),
		join(missingPeerConsumerRoot, "shopify-passing"),
		{ recursive: true },
	);
	await installPackedPackage({
		consumerRoot: missingPeerConsumerRoot,
		hasPlaywright: false,
		tarballPath,
	});

	return {
		consumerRoot,
		doctorMissingChromiumConsumerRoot: doctorMissingChromium.consumerRoot,
		doctorMissingChromiumLaunchMarker: doctorMissingChromium.launchMarker,
		doctorReadyConsumerRoot: doctorReady.consumerRoot,
		doctorReadyLaunchMarker: doctorReady.launchMarker,
		missingPeerConsumerRoot,
		profileDataRoot,
		removal,
	};
};

export const cleanupInstalledCliFixture = async (): Promise<void> => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	);
};

export const markerExists = async ({
	markerDirectory,
	name,
}: MarkerArgs): Promise<boolean> => {
	try {
		await access(join(markerDirectory, name));
		return true;
	} catch {
		return false;
	}
};

export const expectMarkersAbsent = async ({
	markerDirectory,
	names,
}: ExpectMarkersAbsentArgs): Promise<void> => {
	for (const name of names) {
		await expect(markerExists({ markerDirectory, name }), name).resolves.toBe(
			false,
		);
	}
};

export const expectOrdinaryLaneFixturesPresent = async (
	consumerRoot: string,
): Promise<void> => {
	await expect(
		access(join(consumerRoot, "playwright.config.ts")),
	).resolves.toBeUndefined();
	await expect(
		access(join(consumerRoot, "ordinary-e2e", "must-not-load.spec.ts")),
	).resolves.toBeUndefined();
};

export const generatedConfigDirectories = async (
	root: string,
): Promise<Set<string>> => {
	const entries = await readdir(root, { withFileTypes: true });
	return new Set(
		entries
			.filter(
				(entry) =>
					entry.isDirectory() && entry.name.startsWith(generatedConfigPrefix),
			)
			.map((entry) => entry.name),
	);
};

export const waitForMarker = async ({
	markerDirectory,
	name,
	timeoutMs,
}: WaitForMarkerArgs): Promise<void> => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await markerExists({ markerDirectory, name })) return;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
	}
	throw new Error(`Timed out waiting for marker ${name}`);
};

export const waitForProcessToExit = async ({
	pid,
	timeoutMs,
}: WaitForProcessToExitArgs): Promise<void> => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			process.kill(pid, 0);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
			throw error;
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
	}
	throw new Error(`Process ${pid} remained alive after CLI exit`);
};

const waitForChildToExit = async ({
	child,
	timeoutMs,
}: WaitForChildToExitArgs): Promise<void> => {
	if (child.exitCode !== null || child.signalCode !== null) return;

	await new Promise<void>((resolveExit, rejectExit) => {
		const timeout = setTimeout(() => {
			child.off("exit", handleExit);
			rejectExit(
				new Error(`CLI process ${child.pid ?? "unknown"} remained alive`),
			);
		}, timeoutMs);
		const handleExit = (): void => {
			clearTimeout(timeout);
			resolveExit();
		};
		child.once("exit", handleExit);
	});
};

const signalProcess = ({ pid, signal }: SignalProcessArgs): void => {
	try {
		process.kill(pid, signal);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
};

export const terminateAndAwaitProcesses = async ({
	child,
	descendantPids,
}: TerminateAndAwaitProcessesArgs): Promise<void> => {
	const pids = [...new Set(descendantPids)];
	for (const pid of pids) signalProcess({ pid, signal: "SIGTERM" });
	if (child.pid && child.exitCode === null && child.signalCode === null) {
		signalProcess({ pid: child.pid, signal: "SIGTERM" });
	}

	const exitResults = await Promise.allSettled([
		...pids.map((pid) => waitForProcessToExit({ pid, timeoutMs: 1_000 })),
		waitForChildToExit({ child, timeoutMs: 1_000 }),
	]);
	const lingeringPids = pids.filter(
		(_pid, index) => exitResults[index]?.status === "rejected",
	);
	const shouldForceStopChild = exitResults[pids.length]?.status === "rejected";

	for (const pid of lingeringPids) signalProcess({ pid, signal: "SIGKILL" });
	if (
		shouldForceStopChild &&
		child.pid &&
		child.exitCode === null &&
		child.signalCode === null
	) {
		signalProcess({ pid: child.pid, signal: "SIGKILL" });
	}

	await Promise.all([
		...lingeringPids.map((pid) =>
			waitForProcessToExit({ pid, timeoutMs: 1_000 }),
		),
		...(shouldForceStopChild
			? [waitForChildToExit({ child, timeoutMs: 1_000 })]
			: []),
	]);
};
