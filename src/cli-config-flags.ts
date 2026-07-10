import { Flags } from "@oclif/core";

import type { ResolveConfigOptions } from "./shopify-e2e-config.js";

export const configFlags = {
	"app-url": Flags.string({
		description: "Shopify app URL used by the app under test.",
	}),
	"auth-profile": Flags.string({
		description: "Named Shopify auth profile to use.",
	}),
	"cdp-port": Flags.integer({
		description: "Chrome DevTools Protocol port.",
		min: 1,
	}),
	"cdp-url": Flags.string({
		description: "Chrome DevTools Protocol HTTP or websocket URL.",
	}),
	"chrome-path": Flags.string({
		description: "Path to the Chrome executable.",
	}),
	config: Flags.string({
		char: "c",
		description: "Path to a shopify-e2e config file.",
	}),
	"env-file": Flags.string({
		description:
			"Path to an env file to load before reading SHOPIFY_E2E_* values.",
	}),
	"chrome-profile-path": Flags.string({
		description: "Path to the persistent Chrome profile directory.",
	}),
	shop: Flags.string({
		description: "Shop domain, for example example.myshopify.com.",
	}),
	"storefront-domain": Flags.string({
		description: "Storefront domain when it differs from the shop domain.",
	}),
	"storefront-password": Flags.string({
		description: "Storefront password for app-owned checkout helpers.",
	}),
} as const;

export function configOverridesFromFlags(
	flags: Record<string, unknown>,
): ResolveConfigOptions {
	return {
		appUrl: stringFlag(flags["app-url"]),
		authProfile: rawStringFlag(flags["auth-profile"]),
		cdpPort: numberFlag(flags["cdp-port"]),
		cdpUrl: stringFlag(flags["cdp-url"]),
		chromeExecutablePath: stringFlag(flags["chrome-path"]),
		chromeProfilePath: stringFlag(flags["chrome-profile-path"]),
		configPath: stringFlag(flags.config),
		envFile: stringFlag(flags["env-file"]),
		shopDomain: stringFlag(flags.shop),
		storefrontDomain: stringFlag(flags["storefront-domain"]),
		storefrontPassword: stringFlag(flags["storefront-password"]),
	};
}

function rawStringFlag(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function stringFlag(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function numberFlag(value: unknown): number | undefined {
	return typeof value === "number" ? value : undefined;
}
