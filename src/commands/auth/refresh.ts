import { Command, Flags } from "@oclif/core";

import { configFlag, executeAuthCommand } from "../auth.js";

export class AuthRefresh extends Command {
	static override description =
		"Refresh an existing saved profile in consumer-owned headed Chromium.";

	static override examples = [
		"<%= config.bin %> <%= command.id %> --profile customer-primary",
	];

	static override flags = {
		config: configFlag,
		profile: Flags.string({ description: "Existing saved profile name" }),
	};

	static override strict = true;

	public async run(): Promise<void> {
		const { flags } = await this.parse(AuthRefresh);
		await executeAuthCommand({
			action: "refresh",
			command: this,
			configPath: flags.config,
			profile: flags.profile,
		});
	}
}
