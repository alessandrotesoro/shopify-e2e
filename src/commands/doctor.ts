import { Command } from "@oclif/core";

import {
	type DoctorCheckId,
	type DoctorReport,
	orchestrateDoctor,
} from "../doctor/doctor-orchestrator.js";
import {
	CommandSignalError,
	createCommandSignalScope,
} from "../process/command-signals.js";

const CHECK_LABELS = {
	chromium: "Chromium",
	config: "Shopify config",
	environment: "Environment",
	"playwright-peer": "Playwright peer",
	project: "Project",
	specs: "Shopify test directory",
	"store-url": "Store URL",
} as const satisfies Readonly<Record<DoctorCheckId, string>>;

interface RenderDoctorReportArgs {
	command: Command;
	report: DoctorReport;
}

const renderDoctorReport = ({
	command,
	report,
}: RenderDoctorReportArgs): void => {
	for (const check of report.checks) {
		command.log(`${check.status} ${CHECK_LABELS[check.id]}: ${check.detail}`);
	}
};

export class Doctor extends Command {
	static override description =
		"Inspect bounded Shopify E2E readiness without running tests or launching a browser.";

	static override strict = true;

	public async run(): Promise<void> {
		await this.parse(Doctor);
		const signals = createCommandSignalScope();
		let report: DoctorReport;
		try {
			report = await orchestrateDoctor({
				options: {
					cwd: process.cwd(),
					environment: process.env,
					signal: signals.signal,
				},
			});
		} catch (error) {
			if (error instanceof CommandSignalError) {
				this.error("Doctor interrupted; no report completed.", {
					exit: signals.exitCode() ?? error.exitCode,
				});
			}
			this.error("shopify-e2e doctor could not inspect local readiness", {
				exit: 1,
			});
		} finally {
			signals.dispose();
		}

		renderDoctorReport({ command: this, report });
		if (report.exitCode !== 0) this.exit(report.exitCode);
	}
}
