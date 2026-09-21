import { useEffect, useSyncExternalStore } from "react";
import { logger } from "@/logger.js";
import { useBaseWorkspaceServices } from "./useWorkspaceServices.js";

/**
 * 「自动审批」是否出现在模式切换器里。事实源是 Host 的 auto-mode.json；
 * 这里只是渲染进程内的只读缓存，设置页保存后通过 publishAutoModeEnabled 同步。
 * 默认 true：配置读不到时不隐藏入口（审批器本身会 fail-closed）。
 */
let enabled = true;
let loaded = false;
const listeners = new Set<() => void>();

export function publishAutoModeEnabled(next: boolean): void {
  loaded = true;
  if (enabled === next) return;
  enabled = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAutoModeEnabled(): boolean {
  const { autoModeService } = useBaseWorkspaceServices();
  useEffect(() => {
    if (loaded || !autoModeService) return;
    let cancelled = false;
    autoModeService
      .getConfig()
      .then((view) => {
        if (!cancelled) publishAutoModeEnabled(view.config.enabled);
      })
      .catch((error: unknown) => logger.warn("[autoMode] load enabled flag failed", error));
    return () => {
      cancelled = true;
    };
  }, [autoModeService]);
  return useSyncExternalStore(
    subscribe,
    () => enabled,
    () => enabled,
  );
}
