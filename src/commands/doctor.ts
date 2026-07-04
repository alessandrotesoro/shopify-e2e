import { Command } from "@oclif/core";
import { configFlags, configOverridesFromFlags } from "../cli-config-flags.js";
import { hasFailingDoctorChecks, runDoctor } from "../doctor-checks.js";
import { resolveShopifyE2EConfig } from "../shopify-e2e-config.js";

export default class Doctor extends Command {
	static flags = configFlags;
	static summary =
		"Check Shopify E2E configuration, Chrome, CDP, auth, and runner state.";

	async run(): Promise<void> {
		const { flags } = await this.parse(Doctor);
		const config = await resolveShopifyE2EConfig(
			configOverridesFromFlags(flags),
		);
		const checks = await runDoctor(config);

		for (const check of checks) {
			this.log(
				`${formatStatus(check.status)} ${check.name}: ${check.message}`,
			);
		}

		if (hasFailingDoctorChecks(checks)) {
			process.exitCode = 1;
		}
	}
}

function formatStatus(status: "fail" | "pass" | "warn"): string {
	if (status === "pass") {
		return "PASS";
	}

	if (status === "warn") {
		return "WARN";
	}

	return "FAIL";
}
