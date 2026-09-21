import {
  ServiceChannels,
  type AutoModeAuditEntry,
  type AutoModeConfigUpdate,
  type AutoModeConfigView,
  type AutoModeGatekeeperDetection,
} from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * Auto 模式配置服务：`~/.zcode/v2/auto-mode.json` 的唯一写入者。
 * Agent 进程只读该文件（按 mtime 热加载），因此这里保存后下一次工具调用即生效。
 * spec：docs/specs/auto-mode.md。
 */
export interface IAutoModeService {
  getConfig(): Promise<AutoModeConfigView>;
  updateConfig(update: AutoModeConfigUpdate): Promise<AutoModeConfigView>;
  /** 最近的审批判定（新在前），来自 Agent 写入的审计日志。 */
  listRecentDecisions(limit?: number): Promise<AutoModeAuditEntry[]>;
  /** 检测旧的外置 gatekeeper hook，避免与原生 auto 模式重复审批。 */
  detectGatekeeperHooks(): Promise<AutoModeGatekeeperDetection>;
}

export const IAutoModeService = createServiceDescriptor<IAutoModeService>(ServiceChannels.AutoMode);
