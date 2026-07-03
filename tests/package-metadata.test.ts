import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("package metadata", () => {
	it("configures oclif pattern commands and space-separated topics", async () => {
		const packageJson = JSON.parse(
			await readFile(resolve("package.json"), "utf8"),
		) as {
			bin: Record<string, string>;
			oclif: Record<string, unknown>;
		};

		expect(packageJson.bin["shopify-e2e"]).toBe("./bin/run.js");
		expect(packageJson.oclif.bin).toBe("shopify-e2e");
		expect(packageJson.oclif.commands).toBe("./dist/commands");
		expect(packageJson.oclif.topicSeparator).toBe(" ");
	});

	it("uses oclif execute in the bin entrypoint so command errors are handled", async () => {
		const bin = await readFile(resolve("bin/run.js"), "utf8");

		expect(bin).toContain('import { execute } from "@oclif/core"');
		expect(bin).toContain("await execute({ dir: import.meta.url })");
	});
});
