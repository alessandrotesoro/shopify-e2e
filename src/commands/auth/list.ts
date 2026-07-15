import { Command } from "@oclif/core";

import { executeAuthCommand } from "../auth.js";

export class AuthList extends Command {
	static override description =
		"List configured and orphaned role-state readiness without loading Playwright.";

	static override strict = true;

	public async run(): Promise<void> {
		await this.parse(AuthList);
		await executeAuthCommand({
			action: "list",
			command: this,
		});
	}
}
