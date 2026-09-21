import { Switch } from "@/components/ui/switch.js";
import { useAutoModeConfig } from "@/hooks/useAutoModeConfig.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { AutoModeBackendCard } from "./AutoModeBackendCard.js";
import { AutoModePolicyCard } from "./AutoModePolicyCard.js";
import { AutoModeRecentDecisions } from "./AutoModeRecentDecisions.js";

/**
 * 设置 → Auto 模式。配置写入 `~/.zcode/v2/auto-mode.json`，Agent 下一次工具调用即生效。
 * spec：docs/specs/auto-mode.md。
 */
export function AutoModeSettingsSection() {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string>) => intl.formatMessage({ id }, values);
  const { gatekeeper, recent, refreshRecent, save, saving, state } = useAutoModeConfig();

  if (state.status === "loading") {
    return (
      <div className="px-1 py-6 text-ui-base text-foreground-subtle">{t("common.loading")}</div>
    );
  }
  if (state.status === "unavailable" || state.status === "error") {
    return (
      <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-ui-base text-foreground-subtle">
        {state.status === "error"
          ? t("settings.autoMode.loadFailed", { message: state.message })
          : t("settings.autoMode.unavailable")}
      </div>
    );
  }

  const { view } = state;
  const { config } = view;

  return (
    <div className="space-y-6">
      {gatekeeper?.detected ? (
        <div className="rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-ui-base text-foreground">
          {t("settings.autoMode.gatekeeperDetected", { path: gatekeeper.configFilePath })}
        </div>
      ) : null}

      <SettingsGroupCard>
        <SettingsRow
          label={t("settings.autoMode.enabled")}
          description={t("settings.autoMode.enabled.description")}
          control={
            <Switch
              aria-label={t("settings.autoMode.enabled")}
              checked={config.enabled}
              disabled={saving}
              onCheckedChange={(enabled) => void save({ ...config, enabled })}
            />
          }
        />
      </SettingsGroupCard>

      <AutoModeBackendCard
        view={view}
        disabled={saving}
        onSave={(next, replaceApiKeys) => void save(next, replaceApiKeys)}
      />

      <AutoModePolicyCard config={config} disabled={saving} onSave={(next) => void save(next)} />

      <AutoModeRecentDecisions entries={recent} onRefresh={() => void refreshRecent()} />

      <div className="px-1 text-ui-xs text-foreground-subtle">
        {t("settings.autoMode.configFile", { path: view.configFilePath })}
      </div>
    </div>
  );
}
