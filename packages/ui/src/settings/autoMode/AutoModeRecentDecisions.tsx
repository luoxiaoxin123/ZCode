import type { AutoModeAuditEntry } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsGroupCard } from "@/settings/SettingsPageParts.js";

const OUTCOME_CLASS: Record<AutoModeAuditEntry["outcome"], string> = {
  allow: "text-foreground-subtle",
  block: "text-destructive",
  limit: "text-warning",
  uncertain: "text-warning",
  unavailable: "text-warning",
};

/** 最近的审批判定，来自 Agent 写入的审计日志（新在前）。 */
export function AutoModeRecentDecisions({
  entries,
  onRefresh,
}: {
  entries: readonly AutoModeAuditEntry[];
  onRefresh: () => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id });

  return (
    <SettingsGroupCard>
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="text-ui-base font-medium text-foreground">
          {t("settings.autoMode.recent")}
        </div>
        <Button size="sm" variant="ghost" onClick={onRefresh}>
          {t("settings.autoMode.recent.refresh")}
        </Button>
      </div>
      {entries.length === 0 ? (
        <div className="border-t border-border px-4 py-6 text-center text-ui-base text-foreground-subtle">
          {t("settings.autoMode.recent.empty")}
        </div>
      ) : (
        entries.map((entry, index) => (
          <div
            key={`${entry.ts}-${index}`}
            className="grid grid-cols-[88px_minmax(0,1fr)] gap-3 border-t border-border px-4 py-2.5"
          >
            <div className={cn("text-ui-sm font-medium", OUTCOME_CLASS[entry.outcome])}>
              {t(`settings.autoMode.outcome.${entry.outcome}`)}
            </div>
            <div className="min-w-0 space-y-0.5">
              <div className="truncate font-mono text-ui-sm text-foreground" title={entry.snippet}>
                {entry.toolName}: {entry.snippet}
              </div>
              <div className="truncate text-ui-xs text-foreground-subtle" title={entry.reason}>
                {new Date(entry.ts).toLocaleString()} · {entry.backend}
                {entry.cached ? ` · ${t("settings.autoMode.recent.cached")}` : ""} ·{" "}
                {entry.latencyMs}ms · {entry.reason}
              </div>
            </div>
          </div>
        ))
      )}
    </SettingsGroupCard>
  );
}
