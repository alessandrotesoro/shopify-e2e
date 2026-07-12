export interface ShopifyE2EPreflightErrorOptions extends ErrorOptions {
	readonly configPath?: string;
}

export class ShopifyE2EPreflightError extends Error {
	public readonly configPath?: string;
	public readonly exitCode = 2;

	public constructor(
		message: string,
		options: ShopifyE2EPreflightErrorOptions = {},
	) {
		super(message, options);
		this.name = "ShopifyE2EPreflightError";
		this.configPath = options.configPath;
	}
}
