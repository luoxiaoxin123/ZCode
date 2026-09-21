import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AutoModeAuditEntry,
  AutoModeConfig,
  AutoModeConfigUpdate,
  AutoModeConfigView,
  AutoModeGatekeeperDetection,
} from "@zcode/shared";
import { logger } from "@/logger.js";
import { useBaseWorkspaceServices } from "./useWorkspaceServices.js";
import { publishAutoModeEnabled } from "./useAutoModeEnabled.js";

const RECENT_DECISION_LIMIT = 20;

export type AutoModeConfigLoadState =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "error"; message: string }
  | { status: "ready"; view: AutoModeConfigView };

/**
 * Auto 模式设置页的数据源：配置、最近判定、gatekeeper 检测。
 * 配置保存走 Host 的 AutoModeService（唯一写入者），Agent 按 mtime 热加载。
 */
export function useAutoModeConfig() {
  const { autoModeService } = useBaseWorkspaceServices();
  const [state, setState] = useState<AutoModeConfigLoadState>({ status: "loading" });
  const [recent, setRecent] = useState<AutoModeAuditEntry[]>([]);
  const [gatekeeper, setGatekeeper] = useState<AutoModeGatekeeperDetection | null>(null);
  const [saving, setSaving] = useState(false);
  const requestIdRef = useRef(0);

  const reload = useCallback(async () => {
    if (!autoModeService) {
      setState({ status: "unavailable" });
      return;
    }
    const requestId = ++requestIdRef.current;
    try {
      const [view, decisions, detection] = await Promise.all([
        autoModeService.getConfig(),
        autoModeService.listRecentDecisions(RECENT_DECISION_LIMIT),
        autoModeService.detectGatekeeperHooks(),
      ]);
      if (requestId !== requestIdRef.current) return;
      setState({ status: "ready", view });
      publishAutoModeEnabled(view.config.enabled);
      setRecent(decisions);
      setGatekeeper(detection);
    } catch (error) {
      if (requestId !== requestIdRef.current) return;
      logger.warn("[autoMode] load config failed", error);
      setState({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [autoModeService]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const refreshRecent = useCallback(async () => {
    if (!autoModeService) return;
    try {
      setRecent(await autoModeService.listRecentDecisions(RECENT_DECISION_LIMIT));
    } catch (error) {
      logger.warn("[autoMode] load recent decisions failed", error);
    }
  }, [autoModeService]);

  const save = useCallback(
    async (config: AutoModeConfig, replaceApiKeys?: AutoModeConfigUpdate["replaceApiKeys"]) => {
      if (!autoModeService) return false;
      // 乐观更新：开关、下拉等即时生效；失败时回滚到服务端事实。
      setState((previous) =>
        previous.status === "ready"
          ? { status: "ready", view: { ...previous.view, config } }
          : previous,
      );
      setSaving(true);
      try {
        const view = await autoModeService.updateConfig({
          config,
          ...(replaceApiKeys ? { replaceApiKeys } : {}),
        });
        setState({ status: "ready", view });
        publishAutoModeEnabled(view.config.enabled);
        return true;
      } catch (error) {
        logger.warn("[autoMode] save config failed", error);
        await reload();
        return false;
      } finally {
        setSaving(false);
      }
    },
    [autoModeService, reload],
  );

  return { gatekeeper, recent, refreshRecent, reload, save, saving, state };
}
