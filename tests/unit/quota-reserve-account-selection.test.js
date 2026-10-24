import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getSettings: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
  getUsageForProvider: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getSettings: mocks.getSettings,
  getProxyPools: vi.fn(),
  validateApiKey: vi.fn(),
  updateProviderConnection: vi.fn(),
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
  pickProxyPoolId: vi.fn(),
}));
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {},
  resolveProviderId: (provider) => provider,
}));
vi.mock("open-sse/services/usage.js", () => ({
  getUsageForProvider: mocks.getUsageForProvider,
}));
vi.mock("../utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));

const { getProviderCredentials } = await import("@/sse/services/auth.js");
const { recordQuotaReserveSnapshot, resetQuotaReserveCache } = await import("@/sse/services/quotaReserve.js");

const FUTURE_RESET = "2026-10-24T18:00:00.000Z";

function codexQuotas(sessionRemaining) {
  return {
    session: { remaining: sessionRemaining, resetAt: FUTURE_RESET },
    weekly: { remaining: 98, resetAt: FUTURE_RESET },
  };
}

const reserveSettings = () => ({
  fallbackStrategy: "fill-first",
  quotaReserveRouting: {
    enabled: true,
    blockWhenQuotaUnknown: true,
    providers: {
      codex: { enabled: true, fiveHourReservePercent: 25, weeklyReservePercent: 20 },
      claude: { enabled: true, fiveHourReservePercent: 30, weeklyReservePercent: 20 },
    },
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  resetQuotaReserveCache();
  mocks.resolveConnectionProxyConfig.mockResolvedValue({});
});

describe("getProviderCredentials with quota reserve routing", () => {
  it("skips a reserved account and selects the next one by priority", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      { id: "codex-primary", provider: "codex", priority: 1, name: "Primary" },
      { id: "codex-backup", provider: "codex", priority: 2, name: "Backup" },
    ]);
    mocks.getSettings.mockResolvedValue(reserveSettings());
    recordQuotaReserveSnapshot({ id: "codex-primary", provider: "codex" }, { quotas: codexQuotas(18) });
    recordQuotaReserveSnapshot({ id: "codex-backup", provider: "codex" }, { quotas: codexQuotas(89) });

    const result = await getProviderCredentials("codex", null, "gpt-5.6");
    expect(result.connectionId).toBe("codex-backup");
  });

  it("returns allRateLimited with reserve reset info when every account is reserved", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      { id: "codex-only", provider: "codex", priority: 1, name: "Only" },
    ]);
    mocks.getSettings.mockResolvedValue(reserveSettings());
    recordQuotaReserveSnapshot({ id: "codex-only", provider: "codex" }, { quotas: codexQuotas(10) });

    const result = await getProviderCredentials("codex", null, "gpt-5.6");
    expect(result).toMatchObject({
      allRateLimited: true,
      retryAfter: FUTURE_RESET,
      lastErrorCode: 429,
    });
  });

  it("does not change selection when quota reserve routing is disabled", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      { id: "codex-primary", provider: "codex", priority: 1, name: "Primary" },
    ]);
    mocks.getSettings.mockResolvedValue({ fallbackStrategy: "fill-first", quotaReserveRouting: { enabled: false } });
    recordQuotaReserveSnapshot({ id: "codex-primary", provider: "codex" }, { quotas: codexQuotas(1) });

    const result = await getProviderCredentials("codex", null, "gpt-5.6");
    expect(result.connectionId).toBe("codex-primary");
  });
});
