import { getUsageForProvider } from "open-sse/services/usage.js";
import { getSettings, getProviderConnections } from "@/lib/localDb";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import * as log from "../utils/logger.js";

export const QUOTA_RESERVE_PROVIDERS = new Set(["claude", "codex"]);
const CLAUDE_REFRESH_MS = 5 * 60 * 1000;
const CODEX_REFRESH_MS = 60 * 1000;
const STALE_MULTIPLIER = 2;

const snapshots = new Map();
const refreshes = new Map();
let schedulerStarted = false;
let schedulerInterval = null;
let initialTimeout = null;
let tickRunning = false;

function cacheTtl(provider) {
  return provider === "claude" ? CLAUDE_REFRESH_MS : CODEX_REFRESH_MS;
}

function asPercent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : 0;
}

function asPolicy(settings, provider) {
  const config = settings?.quotaReserveRouting;
  if (!config?.enabled || !QUOTA_RESERVE_PROVIDERS.has(provider)) return null;

  const providerConfig = config.providers?.[provider];
  if (!providerConfig?.enabled) return null;
  return {
    fiveHourReservePercent: asPercent(providerConfig.fiveHourReservePercent),
    weeklyReservePercent: asPercent(providerConfig.weeklyReservePercent),
    blockWhenQuotaUnknown: config.blockWhenQuotaUnknown !== false,
  };
}

function quotaRemaining(quota) {
  if (Number.isFinite(Number(quota?.remaining))) return Number(quota.remaining);
  if (Number.isFinite(Number(quota?.remainingPercentage))) return Number(quota.remainingPercentage);
  if (Number.isFinite(Number(quota?.used)) && Number.isFinite(Number(quota?.total)) && Number(quota.total) > 0) {
    return Math.max(0, 100 - (Number(quota.used) / Number(quota.total)) * 100);
  }
  return null;
}

function activeWindow(quota, now) {
  const resetAtMs = Date.parse(quota?.resetAt || "");
  return Number.isFinite(resetAtMs) && resetAtMs > now;
}

function protectedWindows(provider) {
  if (provider === "claude") {
    return [
      { quotaName: "session (5h)", reserveName: "fiveHourReservePercent" },
      { quotaName: "weekly (7d)", reserveName: "weeklyReservePercent" },
    ];
  }
  if (provider === "codex") {
    return [
      { quotaName: "session", reserveName: "fiveHourReservePercent" },
      { quotaName: "weekly", reserveName: "weeklyReservePercent" },
    ];
  }
  return [];
}

/**
 * Evaluates an already-cached quota snapshot. This function never fetches
 * upstream data, so account selection remains fast and deterministic.
 */
export function getQuotaReserveBlock(provider, snapshot, policy, now = Date.now()) {
  if (!policy) return null;
  if (!snapshot || now - snapshot.fetchedAt > cacheTtl(provider) * STALE_MULTIPLIER) {
    return policy.blockWhenQuotaUnknown ? { reason: "quota unavailable", resetAt: null } : null;
  }

  for (const { quotaName, reserveName } of protectedWindows(provider)) {
    const quota = snapshot.quotas?.[quotaName];
    const remaining = quotaRemaining(quota);
    if (remaining === null || !activeWindow(quota, now)) continue;

    const reserve = policy[reserveName];
    if (remaining <= reserve) {
      return { quotaName, remaining, reserve, resetAt: quota.resetAt };
    }
  }
  return null;
}

/**
 * Filters candidates from the in-memory quota cache. The blocked list carries
 * reset times so the normal combo fallback can advertise the next retry.
 */
export function filterConnectionsByQuotaReserve(connections, provider, settings, now = Date.now()) {
  const policy = asPolicy(settings, provider);
  if (!policy || !Array.isArray(connections) || connections.length === 0) {
    return { connections, blocked: [] };
  }

  const blocked = [];
  const available = connections.filter((connection) => {
    const block = getQuotaReserveBlock(provider, snapshots.get(connection.id), policy, now);
    if (!block) return true;
    blocked.push({ connection, ...block });
    const detail = block.quotaName
      ? `${block.quotaName} ${Math.round(block.remaining)}% <= reserve ${block.reserve}% until ${block.resetAt}`
      : block.reason;
    log.info("QUOTA_RESERVE", `${provider}/${connection.id?.slice(0, 8)} skipped: ${detail}`);
    return false;
  });
  return { connections: available, blocked };
}

function earliestReset(blocked) {
  return blocked
    .map((entry) => entry.resetAt)
    .filter((resetAt) => Date.parse(resetAt || "") > Date.now())
    .sort()[0] || null;
}

export function getQuotaReserveUnavailable(blocked) {
  if (!blocked?.length) return null;
  const first = blocked[0];
  const retryAfter = earliestReset(blocked);
  const protectedWindow = first.quotaName
    ? `${first.quotaName} reserve reached (${Math.round(first.remaining)}% <= ${first.reserve}%)`
    : "quota status unavailable";
  return {
    allRateLimited: true,
    retryAfter,
    retryAfterHuman: retryAfter ? `quota reserve until ${retryAfter}` : "quota reserve is active",
    lastError: `Quota reserve: ${protectedWindow}`,
    lastErrorCode: 429,
  };
}

export function recordQuotaReserveSnapshot(connection, usage) {
  if (!connection?.id || !QUOTA_RESERVE_PROVIDERS.has(connection.provider)) return;
  if (!usage?.quotas || typeof usage.quotas !== "object") return;
  snapshots.set(connection.id, { quotas: usage.quotas, fetchedAt: Date.now() });
}

async function quotaProxyOptions(connection) {
  const proxyConfig = await resolveConnectionProxyConfig(connection.providerSpecificData);
  return {
    connectionProxyEnabled: proxyConfig.connectionProxyEnabled === true,
    connectionProxyUrl: proxyConfig.connectionProxyUrl || "",
    connectionNoProxy: proxyConfig.connectionNoProxy || "",
    vercelRelayUrl: proxyConfig.vercelRelayUrl || "",
    strictProxy: false,
  };
}

async function refreshConnection(connection) {
  if (refreshes.has(connection.id)) return refreshes.get(connection.id);

  const refresh = (async () => {
    const usage = await getUsageForProvider(connection, await quotaProxyOptions(connection));
    if (!usage?.quotas || typeof usage.quotas !== "object") {
      throw new Error(usage?.message || "Quota API returned no quota windows");
    }
    recordQuotaReserveSnapshot(connection, usage);
    return usage;
  })().catch((error) => {
    log.warn("QUOTA_RESERVE", `${connection.provider}/${connection.id?.slice(0, 8)} quota refresh failed`, {
      error: error?.message || String(error),
    });
    return null;
  }).finally(() => refreshes.delete(connection.id));

  refreshes.set(connection.id, refresh);
  return refresh;
}

export async function runQuotaReserveRefreshTick() {
  if (tickRunning) return;
  tickRunning = true;
  try {
    const settings = await getSettings();
    if (!settings.quotaReserveRouting?.enabled) return;

    const active = await getProviderConnections({ isActive: true });
    const now = Date.now();
    const due = active.filter((connection) => {
      const policy = asPolicy(settings, connection.provider);
      const snapshot = snapshots.get(connection.id);
      return policy && (!snapshot || now - snapshot.fetchedAt >= cacheTtl(connection.provider));
    });

    for (const connection of due) {
      await refreshConnection(connection);
    }
  } catch (error) {
    log.warn("QUOTA_RESERVE", "Quota refresh tick failed", { error: error?.message || String(error) });
  } finally {
    tickRunning = false;
  }
}

export function startQuotaReserveScheduler() {
  if (schedulerStarted || typeof window !== "undefined") return false;
  schedulerStarted = true;

  const tick = () => runQuotaReserveRefreshTick().catch(() => {});
  initialTimeout = setTimeout(tick, 5_000);
  schedulerInterval = setInterval(tick, CODEX_REFRESH_MS);
  initialTimeout.unref?.();
  schedulerInterval.unref?.();
  return true;
}

export function configureQuotaReserveScheduler() {
  return startQuotaReserveScheduler();
}

export function stopQuotaReserveScheduler() {
  if (initialTimeout) clearTimeout(initialTimeout);
  if (schedulerInterval) clearInterval(schedulerInterval);
  initialTimeout = null;
  schedulerInterval = null;
  schedulerStarted = false;
  tickRunning = false;
}

export function resetQuotaReserveCache() {
  snapshots.clear();
  refreshes.clear();
}
