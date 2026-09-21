import type {
  AutoModeConfig,
  AutoModeConfigView,
  AutoModeCustomEndpoint,
  AutoModeCustomProtocol,
  AutoModeLlmSource,
  AutoModeThinkingParam,
} from "@zcode/shared";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { AutoModeCommitInput, AutoModeSelect } from "./AutoModeControls.js";
import { AutoModeModelPicker } from "./AutoModeModelPicker.js";

type ReplaceApiKeys = { custom?: string; typesafe?: string };
type SaveConfig = (config: AutoModeConfig, replaceApiKeys?: ReplaceApiKeys) => void;

const MS_PER_SECOND = 1_000;
const MIN_TIMEOUT_SECONDS = 3;
const MAX_TIMEOUT_SECONDS = 180;
const DEFAULT_CUSTOM_ENDPOINT: AutoModeCustomEndpoint = {
  apiKey: "",
  baseURL: "",
  model: "",
  protocol: "openai-compatible",
  thinkingParam: "none",
};

function clampNumber(raw: string, min: number, max: number, fallback: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function AutoModeBackendCard({
  view,
  onSave,
  disabled,
}: {
  view: AutoModeConfigView;
  onSave: SaveConfig;
  disabled?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string>) => intl.formatMessage({ id }, values);
  const { config, apiKeys } = view;
  const custom = config.llm.custom ?? DEFAULT_CUSTOM_ENDPOINT;
  const setLlm = (patch: Partial<AutoModeConfig["llm"]>) =>
    onSave({ ...config, llm: { ...config.llm, ...patch } });
  const setCustom = (patch: Partial<AutoModeCustomEndpoint>) =>
    setLlm({ custom: { ...custom, ...patch } });
  const setTypeSafe = (patch: Partial<AutoModeConfig["typesafe"]>) =>
    onSave({ ...config, typesafe: { ...config.typesafe, ...patch } });
  const keyPlaceholder = (state: { configured: boolean; masked?: string }) =>
    state.configured
      ? t("settings.autoMode.apiKey.configured", { masked: state.masked ?? "" })
      : t("settings.autoMode.apiKey.empty");

  return (
    <SettingsGroupCard>
      <SettingsRow
        label={t("settings.autoMode.backend")}
        description={t("settings.autoMode.backend.description")}
        control={
          <AutoModeSelect
            ariaLabel={t("settings.autoMode.backend")}
            disabled={disabled}
            value={config.backend}
            options={[
              { label: t("settings.autoMode.backend.llm"), value: "llm" },
              { label: t("settings.autoMode.backend.typesafe"), value: "typesafe" },
            ]}
            onValueChange={(backend) => onSave({ ...config, backend })}
          />
        }
      />

      {config.backend === "llm" ? (
        <>
          <SettingsRow
            label={t("settings.autoMode.llm.source")}
            description={t(`settings.autoMode.llm.source.${config.llm.source}.description`)}
            control={
              <AutoModeSelect<AutoModeLlmSource>
                ariaLabel={t("settings.autoMode.llm.source")}
                disabled={disabled}
                value={config.llm.source}
                options={[
                  { label: t("settings.autoMode.llm.source.session"), value: "session" },
                  { label: t("settings.autoMode.llm.source.configured"), value: "configured" },
                  { label: t("settings.autoMode.llm.source.custom"), value: "custom" },
                ]}
                onValueChange={(source) =>
                  setLlm(source === "custom" ? { custom, source } : { source })
                }
              />
            }
          />
          {config.llm.source === "configured" ? (
            <SettingsRow
              label={t("settings.autoMode.llm.model")}
              control={
                <AutoModeModelPicker
                  disabled={disabled}
                  value={config.llm.modelSelection}
                  onChange={(modelSelection) => setLlm({ modelSelection })}
                />
              }
            />
          ) : null}
          {config.llm.source === "custom" ? (
            <>
              <SettingsRow
                label={t("settings.autoMode.custom.protocol")}
                control={
                  <AutoModeSelect<AutoModeCustomProtocol>
                    ariaLabel={t("settings.autoMode.custom.protocol")}
                    disabled={disabled}
                    value={custom.protocol}
                    options={[
                      { label: "OpenAI Compatible", value: "openai-compatible" },
                      { label: "Anthropic", value: "anthropic" },
                    ]}
                    onValueChange={(protocol) => setCustom({ protocol })}
                  />
                }
              />
              <SettingsRow
                label={t("settings.autoMode.custom.baseURL")}
                description={t(`settings.autoMode.custom.baseURL.${custom.protocol}`)}
                controlLayout="wide"
                control={
                  <AutoModeCommitInput
                    ariaLabel={t("settings.autoMode.custom.baseURL")}
                    disabled={disabled}
                    placeholder="https://"
                    type="url"
                    value={custom.baseURL}
                    onCommit={(baseURL) => setCustom({ baseURL: baseURL.trim() })}
                  />
                }
              />
              <SettingsRow
                label={t("settings.autoMode.custom.apiKey")}
                controlLayout="wide"
                control={
                  <AutoModeCommitInput
                    ariaLabel={t("settings.autoMode.custom.apiKey")}
                    disabled={disabled}
                    placeholder={keyPlaceholder(apiKeys.custom)}
                    type="password"
                    value=""
                    onCommit={(key) => onSave(config, { custom: key.trim() })}
                  />
                }
              />
              <SettingsRow
                label={t("settings.autoMode.custom.model")}
                controlLayout="wide"
                control={
                  <AutoModeCommitInput
                    ariaLabel={t("settings.autoMode.custom.model")}
                    disabled={disabled}
                    value={custom.model}
                    onCommit={(model) => setCustom({ model: model.trim() })}
                  />
                }
              />
              <SettingsRow
                label={t("settings.autoMode.custom.thinkingParam")}
                description={t("settings.autoMode.custom.thinkingParam.description")}
                control={
                  <AutoModeSelect<AutoModeThinkingParam>
                    ariaLabel={t("settings.autoMode.custom.thinkingParam")}
                    disabled={disabled}
                    value={custom.thinkingParam}
                    options={(["none", "zhipu", "qwen", "openai", "anthropic"] as const).map(
                      (value) => ({
                        label: t(`settings.autoMode.custom.thinkingParam.${value}`),
                        value,
                      }),
                    )}
                    onValueChange={(thinkingParam) => setCustom({ thinkingParam })}
                  />
                }
              />
            </>
          ) : null}
          <SettingsRow
            label={t("settings.autoMode.llm.thinking")}
            description={t("settings.autoMode.llm.thinking.description")}
            control={
              <Switch
                aria-label={t("settings.autoMode.llm.thinking")}
                checked={config.llm.thinking}
                disabled={disabled}
                onCheckedChange={(thinking) => setLlm({ thinking })}
              />
            }
          />
          <SettingsRow
            label={t("settings.autoMode.llm.twoStage")}
            description={t("settings.autoMode.llm.twoStage.description")}
            control={
              <Switch
                aria-label={t("settings.autoMode.llm.twoStage")}
                checked={config.llm.twoStage}
                disabled={disabled}
                onCheckedChange={(twoStage) => setLlm({ twoStage })}
              />
            }
          />
          <SettingsRow
            label={t("settings.autoMode.timeout")}
            description={t("settings.autoMode.timeout.description")}
            control={
              <AutoModeCommitInput
                ariaLabel={t("settings.autoMode.timeout")}
                disabled={disabled}
                type="number"
                value={String(Math.round(config.llm.timeoutMs / MS_PER_SECOND))}
                onCommit={(raw) =>
                  setLlm({
                    timeoutMs:
                      clampNumber(
                        raw,
                        MIN_TIMEOUT_SECONDS,
                        MAX_TIMEOUT_SECONDS,
                        config.llm.timeoutMs / MS_PER_SECOND,
                      ) * MS_PER_SECOND,
                  })
                }
              />
            }
          />
        </>
      ) : (
        <>
          <div className="border-t border-border px-4 py-3 text-ui-sm text-warning">
            {t("settings.autoMode.typesafe.privacy")}
          </div>
          <SettingsRow
            label={t("settings.autoMode.typesafe.baseURL")}
            controlLayout="wide"
            control={
              <AutoModeCommitInput
                ariaLabel={t("settings.autoMode.typesafe.baseURL")}
                disabled={disabled}
                type="url"
                value={config.typesafe.baseURL}
                onCommit={(baseURL) => setTypeSafe({ baseURL: baseURL.trim() })}
              />
            }
          />
          <SettingsRow
            label={t("settings.autoMode.typesafe.apiKey")}
            controlLayout="wide"
            control={
              <AutoModeCommitInput
                ariaLabel={t("settings.autoMode.typesafe.apiKey")}
                disabled={disabled}
                placeholder={keyPlaceholder(apiKeys.typesafe)}
                type="password"
                value=""
                onCommit={(key) => onSave(config, { typesafe: key.trim() })}
              />
            }
          />
          <SettingsRow
            label={t("settings.autoMode.typesafe.model")}
            controlLayout="wide"
            control={
              <AutoModeCommitInput
                ariaLabel={t("settings.autoMode.typesafe.model")}
                disabled={disabled}
                value={config.typesafe.model}
                onCommit={(model) => setTypeSafe({ model: model.trim() })}
              />
            }
          />
          <SettingsRow
            label={t("settings.autoMode.typesafe.allowProb")}
            description={t("settings.autoMode.typesafe.threshold.description")}
            control={
              <AutoModeCommitInput
                ariaLabel={t("settings.autoMode.typesafe.allowProb")}
                disabled={disabled}
                type="number"
                value={String(config.typesafe.allowProb)}
                onCommit={(raw) =>
                  setTypeSafe({ allowProb: clampNumber(raw, 0.5, 1, config.typesafe.allowProb) })
                }
              />
            }
          />
          <SettingsRow
            label={t("settings.autoMode.typesafe.denyProb")}
            control={
              <AutoModeCommitInput
                ariaLabel={t("settings.autoMode.typesafe.denyProb")}
                disabled={disabled}
                type="number"
                value={String(config.typesafe.denyProb)}
                onCommit={(raw) =>
                  setTypeSafe({ denyProb: clampNumber(raw, 0.5, 1, config.typesafe.denyProb) })
                }
              />
            }
          />
        </>
      )}
    </SettingsGroupCard>
  );
}
