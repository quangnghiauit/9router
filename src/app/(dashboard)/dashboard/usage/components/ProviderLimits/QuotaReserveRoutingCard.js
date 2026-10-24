"use client";

import { useState } from "react";
import Card from "@/shared/components/Card";
import Toggle from "@/shared/components/Toggle";
import Tooltip from "@/shared/components/Tooltip";

const PROVIDER_LABELS = { codex: "Codex", claude: "Claude" };

function clampPercent(value) {
  const parsed = Math.round(Number(value));
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : 0;
}

/**
 * Free-typing percent input: keeps its own draft string while focused so
 * keystrokes are never fought by a parent re-render, and only commits
 * (clamped 0-100) on blur — the same pattern as TokenSaverClient's numeric
 * fields (handlePxpipeMinCharsBlur etc). The parent remounts this (via a
 * `key` keyed on the committed value) instead of syncing props→state in an
 * effect, so an external change (another tab, a failed-save rollback) still
 * reaches the draft without a setState-in-effect render cascade.
 */
function ReservePercentInput({ label, value, onCommit, disabled }) {
  const [draft, setDraft] = useState(String(value));

  return (
    <label className="flex flex-col gap-1 text-xs text-text-muted">
      {label}
      <input
        type="number"
        min={0}
        max={100}
        step={1}
        value={draft}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          const next = clampPercent(draft);
          setDraft(String(next));
          if (next !== value) onCommit(next);
        }}
        className="h-8 w-20 rounded-lg border border-black/10 bg-black/[0.02] px-2 text-sm text-text-primary outline-none transition-colors hover:bg-black/5 disabled:opacity-50 dark:border-white/10 dark:bg-white/[0.03] dark:hover:bg-white/10"
      />
    </label>
  );
}

/**
 * Quota reserve routing settings. Keeps a floor of quota per provider/window
 * that this gateway's own account selection will not spend — another device
 * or person sharing the same subscription can still use that reserve.
 */
export default function QuotaReserveRoutingCard({
  routing,
  onToggleEnabled,
  onUpdateProvider,
  saving,
  error,
}) {
  return (
    <Card padding="sm" className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-text-primary">Quota reserve routing</h3>
          <p className="text-xs text-text-muted">
            Keep a floor of Claude/Codex quota unspent by this gateway&apos;s own account
            selection — e.g. to leave quota for someone else sharing the subscription.
          </p>
        </div>
        <Toggle checked={routing.enabled} onChange={onToggleEnabled} disabled={saving} />
      </div>

      {error && <p className="text-xs text-red-500">{error}</p>}

      {routing.enabled && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {["codex", "claude"].map((providerId) => {
            const provider = routing.providers[providerId];
            return (
              <div
                key={providerId}
                className="rounded-xl border border-black/10 p-3 dark:border-white/10"
              >
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-sm font-medium text-text-primary">
                    {PROVIDER_LABELS[providerId]}
                  </span>
                  <Tooltip text={`Apply quota reserve routing to ${PROVIDER_LABELS[providerId]}`}>
                    <Toggle
                      size="sm"
                      checked={provider.enabled}
                      disabled={saving}
                      onChange={(enabled) => onUpdateProvider(providerId, { enabled })}
                    />
                  </Tooltip>
                </div>
                <div className="flex gap-3">
                  <ReservePercentInput
                    key={`${providerId}-5h-${provider.fiveHourReservePercent}`}
                    label="5h reserve %"
                    value={provider.fiveHourReservePercent}
                    disabled={saving || !provider.enabled}
                    onCommit={(fiveHourReservePercent) =>
                      onUpdateProvider(providerId, { fiveHourReservePercent })
                    }
                  />
                  <ReservePercentInput
                    key={`${providerId}-weekly-${provider.weeklyReservePercent}`}
                    label="Weekly reserve %"
                    value={provider.weeklyReservePercent}
                    disabled={saving || !provider.enabled}
                    onCommit={(weeklyReservePercent) =>
                      onUpdateProvider(providerId, { weeklyReservePercent })
                    }
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}

      <p className="text-[10px] text-text-muted">
        Account order within each provider still follows the existing priority
        setting on the Providers page; combo order on the Combos page controls
        cross-provider fallback. Quota that cannot be read is treated as reserved
        (fail-safe) so routing never guesses.
      </p>
    </Card>
  );
}
