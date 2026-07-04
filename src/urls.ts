export function shopSlug(shopDomain: string): string {
	return shopDomain.trim().replace(/\.myshopify\.com$/i, "");
}

export function adminStoreUrl(shopDomain: string): string {
	return `https://admin.shopify.com/store/${shopSlug(shopDomain)}`;
}

export function legacyAdminUrl(shopDomain: string): string {
	return `https://${shopDomain.trim()}/admin`;
}

export function storefrontUrl(shopDomain: string, pathname = "/"): string {
	return new URL(pathname, `https://${shopDomain.trim()}`).toString();
}

export function isShopifyAdminUrl(value: string, shopDomain: string): boolean {
	const expectedShopDomain = shopDomain.trim().toLowerCase();
	const expectedSlug = shopSlug(shopDomain).toLowerCase();

	try {
		const url = new URL(value);
		const host = url.hostname.toLowerCase();
		const path = url.pathname.toLowerCase();

		if (
			host === "admin.shopify.com" &&
			(path === `/store/${expectedSlug}` ||
				path.startsWith(`/store/${expectedSlug}/`))
		) {
			return true;
		}

		return (
			host === expectedShopDomain &&
			(path === "/admin" || path.startsWith("/admin/"))
		);
	} catch {
		return false;
	}
}

export function isShopifyLoginUrl(value: string): boolean {
	try {
		const url = new URL(value);
		const host = url.hostname.toLowerCase();
		const path = url.pathname.toLowerCase();

		if (host === "accounts.shopify.com") {
			return true;
		}

		if (host === "admin.shopify.com") {
			return ["/login", "/challenge", "/auth"].some((adminLoginPath) =>
				path.includes(adminLoginPath),
			);
		}

		return path === "/admin/auth/login" || path.includes("/account/login");
	} catch {
		return false;
	}
}

export function devtoolsVersionUrl(cdpUrl: string): string {
	return devtoolsUrl(cdpUrl, "/json/version");
}

export function devtoolsListUrl(cdpUrl: string): string {
	return devtoolsUrl(cdpUrl, "/json/list");
}

function devtoolsUrl(cdpUrl: string, pathname: string): string {
	const url = new URL(cdpUrl);

	if (url.protocol === "ws:") {
		url.protocol = "http:";
	}

	if (url.protocol === "wss:") {
		url.protocol = "https:";
	}

	url.pathname = pathname;
	url.search = "";
	url.hash = "";

	return url.toString();
}
