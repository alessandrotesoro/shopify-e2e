# Real-store smoke consumer

This private consumer verifies one boundary: the current local `@sematico/shopify-e2e` build can launch consumer-owned Playwright and load a real public Shopify storefront in Chromium.

It is intentionally manual. The repository's automated verification does not run this network- and browser-dependent spec.

## Prepare the CLI

From the package repository root, build and register the current package with npm:

```sh
npm run build
npm link
```

Rebuild before rerunning the smoke test after changing CLI source because the executable loads compiled files from `dist`.

## Prepare the consumer

From this directory, install its exact Playwright dependency, link the package without saving a machine-specific path, and install consumer-owned Chromium:

```sh
npm install
npm link @sematico/shopify-e2e --no-save
npx playwright install chromium
```

The consumer owns `@playwright/test@1.61.1` and the browser installation. The CLI does not install or manage browsers.

## Run the smoke test

Create the ignored local environment file from the committed example:

```sh
cp .env.example .env
```

Edit `.env` and set `SHOPIFY_STORE_URL` to a publicly reachable Shopify storefront that needs no password, authentication, special headers, or challenge completion. Then run:

```sh
npm run smoke
```

Run these commands from this directory so the CLI loads this consumer's `.env` and resolves its dedicated configuration and Playwright installation. The CLI only loads the variable; the spec still validates that the URL is present and uses HTTP or HTTPS. Success reports one passed test and exits `0`.

The spec performs one read-only navigation and checks only that the final document response succeeded. It does not inspect theme content or interact with products, accounts, carts, checkout, or store state.

## Expected failures

- Missing, relative, malformed, or non-HTTP(S) `SHOPIFY_STORE_URL` values fail the spec with exit `1`.
- Missing Chromium reports Playwright's browser-install guidance and exits non-zero.
- DNS, TLS, timeout, challenge, password, or unsuccessful HTTP responses fail as ordinary Playwright navigation results.
- A missing or incompatible consumer Playwright peer remains a CLI preflight failure.

Do not commit `.env`, a target URL, credentials, browser binaries, `node_modules`, or Playwright output.
