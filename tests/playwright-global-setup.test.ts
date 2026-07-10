import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	missingLiveShopifyPrerequisites: vi.fn(),
	resolveShopifyE2EConfig: vi.fn(),
	validateShopifySession: vi.fn(),
}));

vi.mock("../src/shopify-e2e-config.js", () => ({
	missingLiveShopifyPrerequisites: mocks.missingLiveShopifyPrerequisites,
	resolveShopifyE2EConfig: mocks.resolveShopifyE2EConfig,
}));

vi.mock("../src/shopify-session.js", () => ({
	validateShopifySession: mocks.validateShopifySession,
}));

const { default: globalSetup } = await import(
	"../src/playwright/global-setup.js"
);

describe("Playwright global setup", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		delete process.env.SHOPIFY_E2E_SKIP_GLOBAL_SETUP;
		mocks.resolveShopifyE2EConfig.mockResolvedValue({ live: true });
		mocks.missingLiveShopifyPrerequisites.mockReturnValue([]);
	});

	it("returns on explicit skip before resolving config or reading a profile", async () => {
		process.env.SHOPIFY_E2E_SKIP_GLOBAL_SETUP = "1";

		await globalSetup({});

		expect(mocks.resolveShopifyE2EConfig).not.toHaveBeenCalled();
		expect(mocks.validateShopifySession).not.toHaveBeenCalled();
	});

	it("returns for non-live runs before profile validation", async () => {
		mocks.resolveShopifyE2EConfig.mockResolvedValue({ live: false });

		await globalSetup({});

		expect(mocks.validateShopifySession).not.toHaveBeenCalled();
	});

	it("validates live profile and Chrome without retaining a context", async () => {
		const config = { live: true };
		mocks.resolveShopifyE2EConfig.mockResolvedValue(config);

		await globalSetup({});

		expect(mocks.validateShopifySession).toHaveBeenCalledWith(config);
	});
});
