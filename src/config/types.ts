export interface ShopifyE2EConfig {
	readonly testDir: string;
}

export interface LoadShopifyConfigOptions {
	readonly configPath?: string;
	readonly cwd: string;
}

export interface LoadedShopifyConfig {
	readonly configPath: string;
	readonly projectRoot: string;
	readonly specFiles: readonly string[];
	readonly testDir: string;
}
