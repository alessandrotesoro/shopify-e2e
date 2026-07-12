import { Command } from "@oclif/core";

export default class Run extends Command {
	static override description =
		"Run the dedicated Shopify Playwright E2E lane. Run controls are package-owned; arbitrary Playwright arguments are not accepted.";

	public async run(): Promise<void> {
		this.error(
			"Shopify E2E execution is not available in this package shell.",
			{
				exit: 2,
			},
		);
	}
}
