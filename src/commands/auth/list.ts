import { Command } from "@oclif/core";

import { configFlag, executeAuthCommand } from "../auth.js";

export class AuthList extends Command {
	static override description =
		"List saved profiles for the configured store without loading Playwright.";

	static override flags = { config: configFlag };

	static override strict = true;

	public async run(): Promise<void> {
		const { flags } = await this.parse(AuthList);
		await executeAuthCommand({
			action: "list",
			command: this,
			configPath: flags.config,
		});
	}
}
