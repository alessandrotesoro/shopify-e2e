import { Command, Flags } from "@oclif/core";

import { runAppSetupCommand } from "../app-setup-runner.js";
import { configFlags, configOverridesFromFlags } from "../cli-config-flags.js";
import {
	missingLiveShopifyPrerequisites,
	resolveShopifyE2EConfig,
} from "../shopify-e2e-config.js";
import { validateShopifySession } from "../shopify-session.js";
import { runTestCommand } from "../test-runner.js";

export default class Run extends Command {
	static flags = {
		...configFlags,
		"test-file": Flags.string({
			description: "Playwright test file or directory to run.",
			multiple: true,
		}),
	};

	static strict = false;
	static summary = "Validate a Shopify auth profile and run serial tests.";

	async run(): Promise<void> {
		const { argv, flags } = await this.parse(Run);
		const config = await resolveShopifyE2EConfig({
			...configOverridesFromFlags(flags),
			testFiles: Array.isArray(flags["test-file"])
				? flags["test-file"]
				: undefined,
		});
		const missing = missingLiveShopifyPrerequisites(config);

		if (missing.length > 0) {
			this.error(
				`Missing live Shopify e2e prerequisites: ${missing.join(", ")}`,
			);
		}

		await validateShopifySession(config);
		this.log(
			`Using Shopify auth profile ${JSON.stringify(config.authProfile.name)} from ${config.authProfile.storageStatePath}.`,
		);

		const setupCode = await runAppSetupCommand(config, {
			log: (message) => this.log(message),
		});

		if (setupCode !== 0) {
			this.error(
				`App setup command failed with exit code ${setupCode}.`,
				{
					exit: setupCode,
				},
			);
		}

		process.exitCode = await runTestCommand(
			config,
			argv.map((entry) => String(entry)),
		);
	}
}
