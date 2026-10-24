import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUsageForProvider: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
  getSettings: vi.fn(),
  getProviderConnections: vi.fn(),
}));

vi.mock("open-sse/services/usage.js", () => ({
  getUsageForProvider: mocks.getUsageForProvider,
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
}));
vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  getProviderConnections: mocks.getProviderConnections,
}));
vi.mock("../utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));

const {
  getQuotaReserveBlock,
  filterConnectionsByQuotaReserve,
  getQuotaReserveUnavailable,
  recordQuotaReserveSnapshot,
  runQuotaReserveRefreshTick,
  resetQuotaReserveCache,
} = await import("@/sse/services/quotaReserve.js");

const NOW = new Date("2026-10-24T12:00:00.000Z").getTime();
const FUTURE_RESET = "2026-10-24T18:00:00.000Z";
const PAST_RESET = "2026-10-24T06:00:00.000Z";

const enabledPolicy = () => ({ fiveHourReservePercent: 30, weeklyReservePercent: 20, blockWhenQuotaUnknown: true });

function claudeQuotas({ fiveHour = 69, weekly = 95 } = {}) {
  return {
    "session (5h)": { used: 100 - fiveHour, total: 100, remaining: fiveHour, resetAt: FUTURE_RESET },
    "weekly (7d)": { used: 100 - weekly, total: 100, remaining: weekly, resetAt: FUTURE_RESET },
  };
}

function codexQuotas({ session = 89, weekly = 98 } = {}) {
  return {
    session: { used: 100 - session, total: 100, remaining: session, resetAt: FUTURE_RESET },
    weekly: { used: 100 - weekly, total: 100, remaining: weekly, resetAt: FUTURE_RESET },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetQuotaReserveCache();
});

describe("getQuotaReserveBlock (pure)", () => {
  it("allows a Claude account above both reserves", () => {
    const snapshot = { quotas: claudeQuotas(), fetchedAt: NOW };
    expect(getQuotaReserveBlock("claude", snapshot, enabledPolicy(), NOW)).toBeNull();
  });

  it("blocks when the 5h window is at or below the reserve", () => {
    const snapshot = { quotas: claudeQuotas({ fiveHour: 29 }), fetchedAt: NOW };
    const block = getQuotaReserveBlock("claude", snapshot, enabledPolicy(), NOW);
    expect(block).toMatchObject({ quotaName: "session (5h)", remaining: 29, reserve: 30 });
  });

  it("blocks when the weekly window is at or below the reserve", () => {
    const snapshot = { quotas: claudeQuotas({ weekly: 20 }), fetchedAt: NOW };
    const block = getQuotaReserveBlock("claude", snapshot, enabledPolicy(), NOW);
    expect(block).toMatchObject({ quotaName: "weekly (7d)", remaining: 20, reserve: 20 });
  });

  it("ignores a window whose reset time has already passed", () => {
    const snapshot = {
      quotas: { "session (5h)": { remaining: 5, resetAt: PAST_RESET } },
      fetchedAt: NOW,
    };
    expect(getQuotaReserveBlock("claude", snapshot, enabledPolicy(), NOW)).toBeNull();
  });

  it("evaluates Codex session/weekly keys", () => {
    const snapshot = { quotas: codexQuotas({ session: 22 }), fetchedAt: NOW };
    const block = getQuotaReserveBlock("codex", snapshot, enabledPolicy(), NOW);
    expect(block).toMatchObject({ quotaName: "session", remaining: 22, reserve: 30 });
  });

  it("treats a stale snapshot as unknown and blocks when configured fail-safe", () => {
    const stale = { quotas: claudeQuotas(), fetchedAt: NOW - 20 * 60 * 1000 };
    const block = getQuotaReserveBlock("claude", stale, enabledPolicy(), NOW);
    expect(block).toMatchObject({ reason: "quota unavailable" });
  });

  it("allows a stale snapshot through when blockWhenQuotaUnknown is false", () => {
    const stale = { quotas: claudeQuotas(), fetchedAt: NOW - 20 * 60 * 1000 };
    const policy = { ...enabledPolicy(), blockWhenQuotaUnknown: false };
    expect(getQuotaReserveBlock("claude", stale, policy, NOW)).toBeNull();
  });

  it("returns null for an unconfigured policy", () => {
    expect(getQuotaReserveBlock("claude", { quotas: claudeQuotas(), fetchedAt: NOW }, null, NOW)).toBeNull();
  });
});

describe("filterConnectionsByQuotaReserve", () => {
  const settingsWith = (overrides = {}) => ({
    quotaReserveRouting: {
      enabled: true,
      blockWhenQuotaUnknown: true,
      providers: {
        claude: { enabled: true, fiveHourReservePercent: 30, weeklyReservePercent: 20 },
        codex: { enabled: true, fiveHourReservePercent: 25, weeklyReservePercent: 20 },
      },
      ...overrides,
    },
  });

  it("keeps all connections when routing is disabled", () => {
    const connections = [{ id: "a", provider: "claude" }];
    const settings = { quotaReserveRouting: { enabled: false } };
    const result = filterConnectionsByQuotaReserve(connections, "claude", settings, NOW);
    expect(result.connections).toEqual(connections);
    expect(result.blocked).toEqual([]);
  });

  it("keeps all connections when the provider toggle is off", () => {
    const connections = [{ id: "a", provider: "claude" }];
    recordQuotaReserveSnapshot({ id: "a", provider: "claude" }, { quotas: claudeQuotas({ fiveHour: 1 }) });
    const settings = settingsWith({ providers: { claude: { enabled: false }, codex: { enabled: true, fiveHourReservePercent: 25, weeklyReservePercent: 20 } } });
    const result = filterConnectionsByQuotaReserve(connections, "claude", settings, NOW);
    expect(result.connections).toEqual(connections);
  });

  it("drops a Codex account whose session window hit reserve, keeps the one that didn't", () => {
    const low = { id: "codex-low", provider: "codex" };
    const ok = { id: "codex-ok", provider: "codex" };
    recordQuotaReserveSnapshot(low, { quotas: codexQuotas({ session: 18 }) });
    recordQuotaReserveSnapshot(ok, { quotas: codexQuotas({ session: 89 }) });

    const result = filterConnectionsByQuotaReserve([low, ok], "codex", settingsWith(), NOW);
    expect(result.connections).toEqual([ok]);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0].connection.id).toBe("codex-low");
  });

  it("returns an empty available list with reset timing when every candidate is reserved", () => {
    const only = { id: "claude-only", provider: "claude" };
    recordQuotaReserveSnapshot(only, { quotas: claudeQuotas({ fiveHour: 10, weekly: 10 }) });
    const result = filterConnectionsByQuotaReserve([only], "claude", settingsWith(), NOW);
    expect(result.connections).toEqual([]);
    const unavailable = getQuotaReserveUnavailable(result.blocked);
    expect(unavailable).toMatchObject({ allRateLimited: true, retryAfter: FUTURE_RESET, lastErrorCode: 429 });
  });

  it("getQuotaReserveUnavailable returns null when nothing was blocked", () => {
    expect(getQuotaReserveUnavailable([])).toBeNull();
  });
});

describe("runQuotaReserveRefreshTick", () => {
  it("does nothing when quota reserve routing is disabled", async () => {
    mocks.getSettings.mockResolvedValue({ quotaReserveRouting: { enabled: false } });
    await runQuotaReserveRefreshTick();
    expect(mocks.getProviderConnections).not.toHaveBeenCalled();
    expect(mocks.getUsageForProvider).not.toHaveBeenCalled();
  });

  it("refreshes only connections whose provider has reserve routing enabled", async () => {
    mocks.getSettings.mockResolvedValue({
      quotaReserveRouting: {
        enabled: true,
        blockWhenQuotaUnknown: true,
        providers: {
          claude: { enabled: true, fiveHourReservePercent: 30, weeklyReservePercent: 20 },
          codex: { enabled: false, fiveHourReservePercent: 25, weeklyReservePercent: 20 },
        },
      },
    });
    mocks.getProviderConnections.mockResolvedValue([
      { id: "claude-a", provider: "claude", providerSpecificData: {} },
      { id: "codex-a", provider: "codex", providerSpecificData: {} },
    ]);
    mocks.resolveConnectionProxyConfig.mockResolvedValue({});
    mocks.getUsageForProvider.mockResolvedValue({ quotas: claudeQuotas() });

    await runQuotaReserveRefreshTick();

    expect(mocks.getUsageForProvider).toHaveBeenCalledTimes(1);
    expect(mocks.getUsageForProvider.mock.calls[0][0].id).toBe("claude-a");
  });

  it("fails open and does not throw when a quota fetch rejects", async () => {
    mocks.getSettings.mockResolvedValue({
      quotaReserveRouting: {
        enabled: true,
        blockWhenQuotaUnknown: true,
        providers: {
          claude: { enabled: true, fiveHourReservePercent: 30, weeklyReservePercent: 20 },
          codex: { enabled: true, fiveHourReservePercent: 25, weeklyReservePercent: 20 },
        },
      },
    });
    mocks.getProviderConnections.mockResolvedValue([{ id: "claude-a", provider: "claude", providerSpecificData: {} }]);
    mocks.resolveConnectionProxyConfig.mockResolvedValue({});
    mocks.getUsageForProvider.mockRejectedValue(new Error("network down"));

    await expect(runQuotaReserveRefreshTick()).resolves.toBeUndefined();
  });
});
