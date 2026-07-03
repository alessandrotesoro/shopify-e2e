import { Command, Flags } from "@oclif/core";

import { configFlags, configOverridesFromFlags } from "../command-flags.js";
import { resolveShopifyE2EConfig } from "../config.js";
import { prepareShopifySession } from "../shopify-session.js";
import { runTestCommand } from "../test-runner.js";

export default class Run extends Command {
	static flags = {
		...configFlags,
		"test-command": Flags.string({
			description: "Custom shell test command. Prefer config object mode for worker enforcement.",
		}),
		"test-file": Flags.string({
			description: "Playwright test file or directory to run.",
			multiple: true,
		}),
		wait: Flags.boolean({
			allowNo: true,
			default: true,
			description: "Wait and poll until Shopify Admin login is ready before tests run.",
		}),
	};

	static strict = false;
	static summary = "Prepare Shopify Admin and run Playwright tests safely.";

	async run(): Promise<void> {
		const { argv, flags } = await this.parse(Run);
		const config = await resolveShopifyE2EConfig({
			...configOverridesFromFlags(flags),
			testCommand: typeof flags["test-command"] === "string" ? flags["test-command"] : undefined,
			testFiles: Array.isArray(flags["test-file"]) ? flags["test-file"] : undefined,
		});

		await prepareShopifySession(config, {
			log: (message) => this.log(message),
			waitForLogin: flags.wait,
		});

		const code = await runTestCommand(
			config,
			argv.map((entry) => String(entry)),
		);

		process.exitCode = code;
	}
}
