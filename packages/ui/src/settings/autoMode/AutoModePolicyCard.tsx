import {
  AUTO_MODE_RULE_SECTIONS,
  DEFAULT_AUTO_MODE_RULES,
  parseAutoModeListRule,
  type AutoModeConfig,
  type AutoModeFallback,
  type AutoModeRuleSection,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { AutoModeLineListEditor, AutoModeSelect } from "./AutoModeControls.js";

const LIST_KINDS = ["allow", "deny"] as const;
type ListKind = (typeof LIST_KINDS)[number];

/** 拿不准 / 故障时的处理、黑白名单、审批规则。 */
export function AutoModePolicyCard({
  config,
  onSave,
  disabled,
}: {
  config: AutoModeConfig;
  onSave: (config: AutoModeConfig) => void;
  disabled?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string>) => intl.formatMessage({ id }, values);
  const fallbackOptions = [
    { label: t("settings.autoMode.fallback.ask"), value: "ask" as const },
    { label: t("settings.autoMode.fallback.deny"), value: "deny" as const },
  ];
  const invalidRuleMessage = (lines: string[]) =>
    t("settings.autoMode.lists.invalid", { rules: lines.join(", ") });

  return (
    <div className="space-y-6">
      <SettingsGroupCard>
        <SettingsRow
          label={t("settings.autoMode.onUncertain")}
          description={t("settings.autoMode.onUncertain.description")}
          control={
            <AutoModeSelect<AutoModeFallback>
              ariaLabel={t("settings.autoMode.onUncertain")}
              disabled={disabled}
              value={config.onUncertain}
              options={fallbackOptions}
              onValueChange={(onUncertain) => onSave({ ...config, onUncertain })}
            />
          }
        />
        <SettingsRow
          label={t("settings.autoMode.onUnavailable")}
          description={t("settings.autoMode.onUnavailable.description")}
          control={
            <AutoModeSelect<AutoModeFallback>
              ariaLabel={t("settings.autoMode.onUnavailable")}
              disabled={disabled}
              value={config.onUnavailable}
              options={fallbackOptions}
              onValueChange={(onUnavailable) => onSave({ ...config, onUnavailable })}
            />
          }
        />
      </SettingsGroupCard>

      <SettingsGroupCard>
        {LIST_KINDS.map((kind: ListKind) => (
          <SettingsRow
            key={kind}
            label={t(`settings.autoMode.lists.${kind}`)}
            description={t(`settings.autoMode.lists.${kind}.description`)}
            controlLayout="wide"
            control={
              <AutoModeLineListEditor
                ariaLabel={t(`settings.autoMode.lists.${kind}`)}
                disabled={disabled}
                invalidMessage={invalidRuleMessage}
                placeholder={t(`settings.autoMode.lists.${kind}.placeholder`)}
                validateLine={(line) => parseAutoModeListRule(line) !== null}
                value={config.lists[kind]}
                onCommit={(lines) =>
                  onSave({ ...config, lists: { ...config.lists, [kind]: lines } })
                }
              />
            }
          />
        ))}
      </SettingsGroupCard>

      <SettingsGroupCard>
        {AUTO_MODE_RULE_SECTIONS.map((section: AutoModeRuleSection) => (
          <SettingsRow
            key={section}
            label={t(`settings.autoMode.rules.${section}`)}
            description={t("settings.autoMode.rules.description")}
            controlLayout="wide"
            control={
              <div className="w-full space-y-1.5">
                <AutoModeLineListEditor
                  ariaLabel={t(`settings.autoMode.rules.${section}`)}
                  disabled={disabled}
                  placeholder={DEFAULT_AUTO_MODE_RULES[section].join("\n")}
                  value={config.rules[section]}
                  onCommit={(lines) =>
                    onSave({ ...config, rules: { ...config.rules, [section]: lines } })
                  }
                />
                {config.rules[section].length > 0 ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={disabled}
                    onClick={() => onSave({ ...config, rules: { ...config.rules, [section]: [] } })}
                  >
                    {t("settings.autoMode.rules.restoreDefault")}
                  </Button>
                ) : null}
              </div>
            }
          />
        ))}
      </SettingsGroupCard>
    </div>
  );
}
