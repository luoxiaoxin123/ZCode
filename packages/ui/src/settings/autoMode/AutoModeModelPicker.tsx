import { useMemo } from "react";
import { completeNewModelSelection } from "@zcode/provider";
import { ZCODE_AGENT_PROVIDER, type ModelSelection } from "@zcode/shared";
import { ModelConfigSelect } from "@/ModelConfigSelect.js";
import { useModelSelectionServiceView } from "@/hooks/useModelSelectionView.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  buildRegistryModelSelectGroups,
  resolveModelDisplayName,
} from "@/lib/modelSelectionGroups.js";
import { decodeCustomModelValue, encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";

const MODEL_ITEM_NEVER_LOCKED = () => false;

/** 从 ZCode 已配置的 Provider（含官方 Coding Plan 与自定义 Provider）里选审批模型。 */
export function AutoModeModelPicker({
  value,
  onChange,
  disabled,
}: {
  value: ModelSelection | undefined;
  onChange: (selection: ModelSelection) => void;
  disabled?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const { modelSelectionService } = useBaseWorkspaceServices();
  const read = useModelSelectionServiceView(modelSelectionService);
  const view = read.state.status === "ready" ? read.state.view : null;
  const modelGroups = useMemo(
    () =>
      view
        ? buildRegistryModelSelectGroups(ZCODE_AGENT_PROVIDER, view, {
            apiKeyLabel: intl.formatMessage({ id: "settings.modelProvider.apiKey" }),
            codingPlanLabel: intl.formatMessage({
              id: "settings.modelProvider.connectionMode.codingPlan",
            }),
            startPlanBadgeLabel: intl.formatMessage({
              id: "settings.modelProvider.connectionMode.startPlanBadge",
            }),
          })
        : [],
    [intl, view],
  );
  const currentValue = value ? encodeCustomModelValue(value.providerId, value.modelId) : "";
  const triggerLabel = currentValue
    ? (resolveModelDisplayName(modelGroups, currentValue) ?? value!.modelId)
    : intl.formatMessage({ id: "settings.autoMode.llm.pickModel" });

  return (
    <ModelConfigSelect
      modelGroups={modelGroups}
      normalizedValue={currentValue}
      triggerLabel={triggerLabel}
      showManageModelsAction={false}
      lockReasonMessage=""
      isItemLocked={MODEL_ITEM_NEVER_LOCKED}
      disabled={disabled || !view}
      focusSelectorOnClose={null}
      contentAlign="end"
      labelVisibilityClassName="inline-flex min-w-0"
      triggerClassName="h-8 w-full min-w-0 justify-between rounded-lg border border-input-border bg-input px-3 py-1.5 text-foreground hover:border-input-border-hover hover:bg-input"
      triggerLabelClassName="inline-flex min-w-0 truncate text-left"
      onValueChange={(next) => {
        const decoded = decodeCustomModelValue(next);
        if (!decoded?.modelName) return;
        const base: ModelSelection = { modelId: decoded.modelName, providerId: decoded.providerId };
        // 与子代理一致：补全 Registry 的默认推理档位，避免执行时选择不完整。
        onChange((view ? completeNewModelSelection(view, base) : undefined) ?? base);
      }}
    />
  );
}
