# `@sematico/shopify-e2e`

A CLI-first, isolated Playwright lane for Shopify end-to-end tests.

Phase one provides one command, one dedicated configuration file, one Shopify test directory, and exactly one Playwright worker. The consuming application owns its Playwright installation.

## Install

Install the package and the supported Playwright peer in the consuming project:

```sh
npm install --save-dev @sematico/shopify-e2e @playwright/test@1.61.1
```

The supported peer range is `@playwright/test >=1.61.1 <1.62.0`. The CLI fails preflight if a compatible consumer-owned peer cannot be resolved from the project.

## Configure

Create `shopify-e2e.config.ts` in the directory where you will run the CLI:

```ts
export default {
	testDir: "tests/shopify-e2e",
};
```

The default export must contain exactly one field, `testDir`, with a non-empty string value. The path is resolved from the current working directory and must identify one real, contained directory with at least one Playwright test file.

By default, the CLI selects `./shopify-e2e.config.ts`. Select another contained TypeScript configuration explicitly:

```sh
shopify-e2e run --config alternate-shopify-e2e.config.ts
```

The selected configuration is trusted consumer code: loading it can run its imports and is not sandboxed. The isolation guarantee is that the package controls which configuration and validated test root it discovers; it is not protection from code intentionally imported by the dedicated configuration.

## Run

Run every test in the configured Shopify directory:

```sh
shopify-e2e run
```

Filter by Playwright test title with the only supported run filters:

```sh
shopify-e2e run --grep "checkout"
shopify-e2e run -g "checkout"
shopify-e2e run --grep-invert "draft order"
```

The CLI runs only Playwright, supplies a generated package-owned Playwright configuration with the validated absolute test directory, and enforces exactly one worker. Before Playwright starts, it prints the selected dedicated configuration and Shopify test directory to standard error.

The consuming application's ordinary `playwright.config.*` files and Playwright specs outside the selected Shopify directory are not discovered, loaded, or run by the CLI. There is no fallback to an ordinary Playwright configuration.

Use `shopify-e2e run --help` for the oclif-generated command reference.

## Exit behavior

- `0`: the CLI and selected Playwright run succeeded.
- `1`: package infrastructure failed. With the supported Playwright version, test failures and a title filter that finds no tests also return `1` from Playwright.
- `2`: CLI usage, dedicated configuration, test-boundary, or Playwright-peer preflight failed before Playwright started.
- Other numeric Playwright child exit codes pass through unchanged.
- An interrupted child maps `SIGINT` to `130` and `SIGTERM` to `143`.

Playwright output is inherited directly, so CI can use the final CLI exit code as the run result.

## Phase-one limits

Phase one does not provide browser lifecycle management, authentication profiles, Shopify setup, storefront or checkout behavior, helper APIs, additional commands, multiple test roots, configured globs, runner adapters, or unrestricted Playwright argument passthrough.

Worker overrides, projects, file selectors, reporters, UI and debug modes, headed mode, retries, shards, and update controls are unavailable. Add these options directly to `shopify-e2e run` and oclif rejects them before Playwright starts.

## Package verification

From this package repository:

```sh
npm run test:installed
npm run verify
```

`test:installed` packs the built package, installs it with the supported Playwright peer into a fixture consumer, and verifies the installed execution and isolation boundary. `verify` runs formatting and lint checks, type checking, fast tests, a clean build, package inspection, and the installed-package gate.
