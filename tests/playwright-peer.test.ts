import {
	mkdir,
	mkdtemp,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ShopifyE2EPreflightError } from "../src/errors.js";
import {
	loadConsumerChromium,
	resolvePlaywrightPeer,
} from "../src/playwright/peer.js";

const temporaryDirectories: string[] = [];

const makeConsumer = async (): Promise<string> => {
	const consumer = await mkdtemp(join(tmpdir(), "shopify-e2e-peer-"));
	temporaryDirectories.push(consumer);
	await writeFile(join(consumer, "package.json"), '{"type":"module"}\n');
	return realpath(consumer);
};

interface FakePeerOptions {
	readonly bin?: unknown;
	readonly binKind?: "directory" | "file";
	readonly moduleKind?: "directory" | "file";
	readonly moduleSource?: string;
	readonly moduleType?: "commonjs" | "module";
	readonly version?: string;
}

interface InstallFakePeerArgs extends FakePeerOptions {
	readonly consumer: string;
}

const installFakePeer = async ({
	consumer,
	...options
}: InstallFakePeerArgs): Promise<{
	readonly binPath: string;
	readonly packageRoot: string;
}> => {
	const packageRoot = join(consumer, "node_modules", "@playwright", "test");
	const bin = Object.hasOwn(options, "bin")
		? options.bin
		: { playwright: "cli.js" };
	await mkdir(packageRoot, { recursive: true });
	await writeFile(
		join(packageRoot, "package.json"),
		JSON.stringify({
			bin,
			exports: {
				".": "./index.js",
				"./package.json": "./package.json",
			},
			name: "@playwright/test",
			type: options.moduleType ?? "module",
			version: options.version ?? "1.61.1",
		}),
	);
	const modulePath = join(packageRoot, "index.js");
	const chromiumPath = join(packageRoot, "chromium");
	await writeFile(chromiumPath, "fake chromium binary\n");
	if (options.moduleKind === "directory") {
		await mkdir(modulePath);
	} else {
		await writeFile(
			modulePath,
			options.moduleSource ??
				`export const chromium = { executablePath() { return ${JSON.stringify(chromiumPath)}; }, async launch() { return { marker: "consumer-browser" }; }, async launchServer() { return { marker: "consumer-server" }; } };\n`,
		);
	}

	const declaredBin =
		typeof bin === "object" && bin !== null && "playwright" in bin
			? bin.playwright
			: undefined;
	if (typeof declaredBin !== "string" || declaredBin.length === 0) {
		return { binPath: join(packageRoot, "cli.js"), packageRoot };
	}
	const binPath = join(packageRoot, declaredBin);
	await mkdir(options.binKind === "directory" ? binPath : dirname(binPath), {
		recursive: true,
	});
	if (options.binKind !== "directory") {
		await writeFile(binPath, "// fake Playwright CLI\n");
	}
	return { binPath, packageRoot };
};

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

describe("consumer Playwright peer resolution", () => {
	it("resolves the compatible peer and declared executable from the consumer cwd", async () => {
		const consumer = await makeConsumer();
		const fakePeer = await installFakePeer({ consumer });

		await expect(resolvePlaywrightPeer(consumer)).resolves.toEqual({
			executablePath: fakePeer.binPath,
			modulePath: join(fakePeer.packageRoot, "index.js"),
		});
	});

	it("does not fall back to the CLI package's development peer", async () => {
		const consumer = await makeConsumer();

		await expect(resolvePlaywrightPeer(consumer)).rejects.toThrow(
			/consumer.*@playwright\/test|@playwright\/test.*consumer/i,
		);
	});

	it("rejects upward resolution to the package's development peer", async () => {
		const nestedConsumer = join(process.cwd(), "tests", "fixtures", "consumer");

		await expect(resolvePlaywrightPeer(nestedConsumer)).rejects.toThrow(
			/must install its own compatible @playwright\/test/i,
		);
	});

	it.each([
		"1.61.0",
		"1.62.0",
		"not-semver",
	])("rejects incompatible version %s with consumer context", async (version) => {
		const consumer = await makeConsumer();
		await installFakePeer({ consumer, version });

		const promise = resolvePlaywrightPeer(consumer);

		await expect(promise).rejects.toBeInstanceOf(ShopifyE2EPreflightError);
		await expect(promise).rejects.toThrow(/>=1\.61\.1 <1\.62\.0/);
		await expect(promise).rejects.toThrow(consumer);
	});

	it.each([
		{ bin: undefined, label: "missing" },
		{ bin: { other: "cli.js" }, label: "unnamed" },
		{ bin: { playwright: "" }, label: "empty" },
	])("rejects a $label declared Playwright bin", async ({ bin }) => {
		const consumer = await makeConsumer();
		await installFakePeer({ bin, consumer });

		await expect(resolvePlaywrightPeer(consumer)).rejects.toThrow(
			/declar.*playwright.*bin/i,
		);
	});

	it("rejects a declared bin that escapes the real package root", async () => {
		const consumer = await makeConsumer();
		await installFakePeer({
			consumer,
			bin: { playwright: "../../escaped.js" },
		});
		await writeFile(
			join(consumer, "node_modules", "escaped.js"),
			"// outside peer\n",
		);

		await expect(resolvePlaywrightPeer(consumer)).rejects.toThrow(
			/outside.*package|inside.*package/i,
		);
	});

	it("rejects a contained bin symlink whose target escapes the real package root", async () => {
		const consumer = await makeConsumer();
		const { binPath } = await installFakePeer({ consumer });
		const outside = join(consumer, "outside-cli.js");
		await rm(binPath);
		await writeFile(outside, "// outside peer\n");
		await symlink(outside, binPath);

		await expect(resolvePlaywrightPeer(consumer)).rejects.toThrow(
			/outside.*package|inside.*package/i,
		);
	});

	it("rejects a declared bin file that is missing", async () => {
		const consumer = await makeConsumer();
		const { binPath } = await installFakePeer({ consumer });
		await rm(binPath);

		await expect(resolvePlaywrightPeer(consumer)).rejects.toThrow(
			/bin is missing/i,
		);
	});

	it("rejects a declared bin that is not a regular file", async () => {
		const consumer = await makeConsumer();
		await installFakePeer({ binKind: "directory", consumer });

		await expect(resolvePlaywrightPeer(consumer)).rejects.toThrow(
			/regular file/i,
		);
	});

	it("rejects a public module symlink whose target escapes the package", async () => {
		const consumer = await makeConsumer();
		const { packageRoot } = await installFakePeer({ consumer });
		const modulePath = join(packageRoot, "index.js");
		const outside = join(consumer, "outside-module.js");
		await rm(modulePath);
		await writeFile(outside, "export const chromium = {};\n");
		await symlink(outside, modulePath);

		await expect(resolvePlaywrightPeer(consumer)).rejects.toThrow(
			/public module resolved outside its package/i,
		);
	});

	it("rejects a public module entry that is not a regular file", async () => {
		const consumer = await makeConsumer();
		await installFakePeer({ consumer, moduleKind: "directory" });

		await expect(resolvePlaywrightPeer(consumer)).rejects.toThrow(
			/public module.*(?:regular file|entry is missing)/i,
		);
	});

	it("loads Chromium only from the verified consumer public module", async () => {
		const consumer = await makeConsumer();
		await installFakePeer({ consumer });
		const peer = await resolvePlaywrightPeer(consumer);
		const chromium = await loadConsumerChromium(peer);

		await expect(chromium.launch({ headless: false })).resolves.toMatchObject({
			marker: "consumer-browser",
		});
		await expect(
			chromium.launchServer({
				handleSIGHUP: true,
				handleSIGINT: false,
				handleSIGTERM: false,
				headless: false,
				host: "127.0.0.1",
				port: 0,
			}),
		).resolves.toMatchObject({ marker: "consumer-server" });
	});

	it("loads Chromium from the verified consumer CommonJS public module", async () => {
		const consumer = await makeConsumer();
		const packageRoot = join(consumer, "node_modules", "@playwright", "test");
		const chromiumPath = join(packageRoot, "chromium");
		await installFakePeer({
			consumer,
			moduleSource: `function test() {}; test.chromium = { executablePath() { return ${JSON.stringify(chromiumPath)}; }, async launch() { return { marker: "consumer-commonjs-browser" }; }, async launchServer() { return { marker: "consumer-commonjs-server" }; } }; module.exports = test;\n`,
			moduleType: "commonjs",
		});
		const peer = await resolvePlaywrightPeer(consumer);
		const chromium = await loadConsumerChromium(peer);

		await expect(chromium.launch({ headless: false })).resolves.toMatchObject({
			marker: "consumer-commonjs-browser",
		});
		await expect(
			chromium.launchServer({
				handleSIGHUP: true,
				handleSIGINT: false,
				handleSIGTERM: false,
				headless: false,
				host: "127.0.0.1",
				port: 0,
			}),
		).resolves.toMatchObject({ marker: "consumer-commonjs-server" });
	});

	it("rejects Chromium without launchServer support", async () => {
		const consumer = await makeConsumer();
		const packageRoot = join(consumer, "node_modules", "@playwright", "test");
		const chromiumPath = join(packageRoot, "chromium");
		await installFakePeer({
			consumer,
			moduleSource: `export const chromium = { executablePath() { return ${JSON.stringify(chromiumPath)}; }, async launch() {} };\n`,
		});
		const peer = await resolvePlaywrightPeer(consumer);

		await expect(loadConsumerChromium(peer)).rejects.toThrow(
			/supported Chromium API/i,
		);
	});

	it("rejects a consumer public module without the supported Chromium API", async () => {
		const consumer = await makeConsumer();
		await installFakePeer({
			consumer,
			moduleSource: "export const firefox = {};\n",
		});
		const peer = await resolvePlaywrightPeer(consumer);

		await expect(loadConsumerChromium(peer)).rejects.toThrow(
			/supported Chromium API/i,
		);
	});

	it("reports install guidance when the consumer Chromium executable is missing", async () => {
		const consumer = await makeConsumer();
		const missingChromium = join(consumer, "missing-chromium");
		await installFakePeer({
			consumer,
			moduleSource: `export const chromium = { executablePath() { return ${JSON.stringify(missingChromium)}; }, async launch() {}, async launchServer() {} };\n`,
		});
		const peer = await resolvePlaywrightPeer(consumer);

		await expect(loadConsumerChromium(peer)).rejects.toThrow(
			/consumer Chromium is unavailable.*playwright install chromium/i,
		);
	});
});
