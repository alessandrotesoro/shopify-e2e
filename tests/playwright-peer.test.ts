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
import { resolvePlaywrightPeer } from "../src/playwright/peer.js";

const temporaryDirectories: string[] = [];

async function makeConsumer(): Promise<string> {
	const consumer = await mkdtemp(join(tmpdir(), "shopify-e2e-peer-"));
	temporaryDirectories.push(consumer);
	await writeFile(join(consumer, "package.json"), '{"type":"module"}\n');
	return realpath(consumer);
}

interface FakePeerOptions {
	readonly bin?: unknown;
	readonly binKind?: "directory" | "file";
	readonly version?: string;
}

async function installFakePeer(
	consumer: string,
	options: FakePeerOptions = {},
): Promise<{ readonly binPath: string; readonly packageRoot: string }> {
	const packageRoot = join(consumer, "node_modules", "@playwright", "test");
	const bin = Object.hasOwn(options, "bin")
		? options.bin
		: { playwright: "cli.js" };
	await mkdir(packageRoot, { recursive: true });
	await writeFile(
		join(packageRoot, "package.json"),
		JSON.stringify({
			bin,
			exports: { "./package.json": "./package.json" },
			name: "@playwright/test",
			version: options.version ?? "1.61.1",
		}),
	);

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
}

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
		const fakePeer = await installFakePeer(consumer);

		await expect(resolvePlaywrightPeer(consumer)).resolves.toEqual({
			executablePath: fakePeer.binPath,
		});
	});

	it("does not fall back to the CLI package's development peer", async () => {
		const consumer = await makeConsumer();

		await expect(resolvePlaywrightPeer(consumer)).rejects.toThrow(
			/consumer.*@playwright\/test|@playwright\/test.*consumer/i,
		);
	});

	it.each([
		"1.61.0",
		"1.62.0",
		"not-semver",
	])("rejects incompatible version %s with consumer context", async (version) => {
		const consumer = await makeConsumer();
		await installFakePeer(consumer, { version });

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
		await installFakePeer(consumer, { bin });

		await expect(resolvePlaywrightPeer(consumer)).rejects.toThrow(
			/declar.*playwright.*bin/i,
		);
	});

	it("rejects a declared bin that escapes the real package root", async () => {
		const consumer = await makeConsumer();
		await installFakePeer(consumer, {
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
		const { binPath } = await installFakePeer(consumer);
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
		const { binPath } = await installFakePeer(consumer);
		await rm(binPath);

		await expect(resolvePlaywrightPeer(consumer)).rejects.toThrow(
			/bin is missing/i,
		);
	});

	it("rejects a declared bin that is not a regular file", async () => {
		const consumer = await makeConsumer();
		await installFakePeer(consumer, { binKind: "directory" });

		await expect(resolvePlaywrightPeer(consumer)).rejects.toThrow(
			/regular file/i,
		);
	});
});
