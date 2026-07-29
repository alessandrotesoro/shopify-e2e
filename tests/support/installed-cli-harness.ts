import {
	access,
	cp,
	mkdir,
	mkdtemp,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { expect } from "vitest";

import {
	installPackedPackage,
	packPackageForConsumer,
} from "./installed-consumer.js";

const temporaryDirectories: string[] = [];
const doctorDedicatedSpecMarker = "doctor-dedicated-spec-loaded.marker";
const doctorPeerCliMarker = "doctor-peer-cli-spawned.marker";

export interface DoctorConsumerFixture {
	readonly consumerRoot: string;
	readonly launchMarker: string;
}

export interface InstalledDoctorCliFixture {
	readonly missingChromium: DoctorConsumerFixture;
	readonly missingPeerConsumerRoot: string;
	readonly ready: DoctorConsumerFixture;
}

export const doctorIsolationMarkers = [
	doctorDedicatedSpecMarker,
	doctorPeerCliMarker,
	"ordinary-config-loaded.marker",
	"ordinary-spec-loaded.marker",
] as const;

export const makeTemporaryDirectory = async (
	prefix: string,
): Promise<string> => {
	const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
	temporaryDirectories.push(directory);
	return directory;
};

export const packVerifiedPackage = async (
	projectRoot: string,
): Promise<string> => {
	const packDirectory = await makeTemporaryDirectory("shopify-e2e-pack-");
	const artifact = await packPackageForConsumer({ projectRoot, packDirectory });
	expect(basename(artifact.tarballPath)).toMatch(
		/^sematico-shopify-e2e-.*\.tgz$/,
	);
	const publishedPaths = artifact.files.map((file) => file.path);
	expect(publishedPaths).toEqual(
		expect.arrayContaining([
			"LICENSE",
			"README.md",
			"bin/run.js",
			"dist/commands.js",
			"dist/config/public.js",
			"dist/config/public.d.ts",
			"dist/playwright/fixtures.js",
			"dist/playwright/fixtures.d.ts",
			"dist/playwright/public.js",
			"dist/playwright/public.d.ts",
			"dist/playwright/storefront.js",
			"dist/playwright/storefront.d.ts",
			"dist/playwright/type-like-human.js",
			"dist/playwright/type-like-human.d.ts",
			"dist/role-states/configured-origin.js",
			"dist/role-states/configured-origin.d.ts",
			"dist/commands/doctor.js",
			"dist/commands/run.js",
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
	const executable = artifact.files.find((file) => file.path === "bin/run.js");
	expect((executable?.mode ?? 0) & 0o111).not.toBe(0);
	return artifact.tarballPath;
};

const doctorSpecSource = `import { writeFileSync } from "node:fs";
import { join } from "node:path";
const markerDirectory = process.env.SHOPIFY_E2E_MARKER_DIR;
if (markerDirectory) writeFileSync(join(markerDirectory, ${JSON.stringify(doctorDedicatedSpecMarker)}), "loaded");
`;

interface PrepareDoctorConsumerArgs {
	fixtureRoot: string;
	tarballPath: string;
	chromiumInstalled: boolean;
}

const prepareDoctorConsumer = async ({
	fixtureRoot,
	tarballPath,
	chromiumInstalled,
}: PrepareDoctorConsumerArgs): Promise<DoctorConsumerFixture> => {
	const consumerRoot = await makeTemporaryDirectory(
		chromiumInstalled
			? "shopify-e2e-doctor-ready-"
			: "shopify-e2e-doctor-missing-chromium-",
	);
	await cp(fixtureRoot, consumerRoot, { recursive: true });
	await writeFile(
		join(consumerRoot, "shopify-passing", "doctor-must-not-load.spec.ts"),
		doctorSpecSource,
	);
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
		`import { writeFileSync } from "node:fs";
import { join } from "node:path";
const markerDirectory = process.env.SHOPIFY_E2E_MARKER_DIR;
if (markerDirectory) writeFileSync(join(markerDirectory, ${JSON.stringify(doctorPeerCliMarker)}), "spawned");
throw new Error("doctor must not spawn Playwright");
`,
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
  launchServer: async () => {
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

interface PrepareMissingPeerConsumerArgs {
	fixtureRoot: string;
	tarballPath: string;
}

const prepareMissingPeerConsumer = async ({
	fixtureRoot,
	tarballPath,
}: PrepareMissingPeerConsumerArgs): Promise<string> => {
	const consumerRoot = await makeTemporaryDirectory(
		"shopify-e2e-doctor-missing-peer-",
	);
	await cp(fixtureRoot, consumerRoot, { recursive: true });
	await installPackedPackage({
		consumerRoot,
		hasPlaywright: false,
		tarballPath,
	});
	return consumerRoot;
};

export const prepareInstalledDoctorCliFixture = async ({
	fixtureRoot,
	projectRoot,
}: {
	readonly fixtureRoot: string;
	readonly projectRoot: string;
}): Promise<InstalledDoctorCliFixture> => {
	const tarballPath = await packVerifiedPackage(projectRoot);
	const [ready, missingChromium, missingPeerConsumerRoot] = await Promise.all([
		prepareDoctorConsumer({
			fixtureRoot,
			tarballPath,
			chromiumInstalled: true,
		}),
		prepareDoctorConsumer({
			fixtureRoot,
			tarballPath,
			chromiumInstalled: false,
		}),
		prepareMissingPeerConsumer({ fixtureRoot, tarballPath }),
	]);
	return { missingChromium, missingPeerConsumerRoot, ready };
};

export const expectMarkersAbsent = async ({
	markerDirectory,
	names,
}: {
	readonly markerDirectory: string;
	readonly names: readonly string[];
}): Promise<void> => {
	for (const name of names) {
		await expect(access(join(markerDirectory, name))).rejects.toMatchObject({
			code: "ENOENT",
		});
	}
};

export const cleanupInstalledCliFixture = async (): Promise<void> => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	);
};
