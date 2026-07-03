# shopify-e2e

Reusable Shopify live E2E helper CLI and Playwright utilities.

## Install

```sh
npm install --save-dev shopify-e2e @playwright/test
```

## Configure

Create `shopify-e2e.config.mjs` in an app repository:

```js
export default {
	shopDomain: "example.myshopify.com",
	appUrl: "https://example-app.ngrok.app",
	cdpPort: 9222,
	chromeProfilePath: ".shopify-e2e/chrome-profile",
	authStatePath: ".shopify-e2e/auth/shopify-storage-state.json",
	testFiles: ["e2e"],
};
```

Shell env values override the config file:

```sh
SHOPIFY_E2E_SHOP_DOMAIN=example.myshopify.com
SHOPIFY_E2E_APP_URL=https://example-app.ngrok.app
SHOPIFY_E2E_CDP_URL=http://127.0.0.1:9222
SHOPIFY_E2E_CHROME_PATH=/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome
SHOPIFY_E2E_CHROME_PROFILE_PATH=.shopify-e2e/chrome-profile
SHOPIFY_E2E_AUTH_STATE_PATH=.shopify-e2e/auth/shopify-storage-state.json
SHOPIFY_E2E_STOREFRONT_PASSWORD=
```

Keep Chrome profile and auth-state paths out of source control. Auth state contains Shopify cookies.

## CLI

```sh
shopify-e2e open
shopify-e2e doctor
shopify-e2e auth save
shopify-e2e auth restore
shopify-e2e run
```

`open` starts Chrome with CDP when needed, restores saved auth state when available, opens Shopify Admin, and waits until the session is logged in.

`run` performs the same session preparation, saves auth state after login, then runs Playwright with `--workers=1` for the default runner path.

`auth save` attaches to the current CDP Chrome context and writes storage state. `auth restore` skips cleanly when no auth state exists and only starts Chrome when there is state to restore.

Pass Playwright args after the command:

```sh
shopify-e2e run -- --project=chromium
```

## Playwright

```ts
import { defineConfig } from "@playwright/test";
import { globalSetup } from "shopify-e2e";

export default defineConfig({
	globalSetup,
	workers: 1,
});
```

Test helpers:

```ts
import {
	buildCartPermalinkUrl,
	createLiveShopifyPage,
	ensureStorefrontUnlocked,
	gotoLiveShopifyPage,
	openLiveShopifyPage,
	resolveStorefrontVariantId,
	slowFill,
} from "shopify-e2e";
```

The helpers attach to one existing Chrome CDP context and reuse one page. Storefront helpers can unlock a password-protected storefront, resolve a variant from a product handle, and build Shopify cart permalinks. Product IDs, checkout assertions, webhook setup, and app-specific UI expectations stay in the app repository.
