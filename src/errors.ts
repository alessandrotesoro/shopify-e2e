export class ShopifyE2EPreflightError extends Error {
	public readonly exitCode = 2;

	public constructor(message: string, options: ErrorOptions = {}) {
		super(message, options);
		this.name = "ShopifyE2EPreflightError";
	}
}

export class ShopifyE2EInfrastructureError extends Error {
	public readonly exitCode = 1;

	public constructor(message: string, options: ErrorOptions = {}) {
		super(message, options);
		this.name = "ShopifyE2EInfrastructureError";
	}
}
