// ============================================================
// Auto Mode Ports - 自动审批（classifier）边界
// ============================================================
//
// auto 权限模式下，未被确定性规则放行的工具调用交给审批器判定。
// spec：docs/specs/auto-mode.md。

import type { AutoModeAuditEntry, AutoModeConfig } from "@zcode/shared/auto-mode";
import type { TraceContext } from "../tracing/tracer.js";
import type { PermissionRuleset } from "./permission.port.js";

export type AutoModeClassifierOutcome =
  /** 审批器判定放行。 */
  | "allow"
  /** 审批器判定拦截；reason 回给主模型。 */
  | "block"
  /** 后端不可用（网络、鉴权、超时、未配置）。 */
  | "unavailable"
  /** 后端给出「拿不准」（TypeSafe 概率未过阈值）。 */
  | "uncertain"
  /** 本会话拦截次数超限，交还给用户确认。 */
  | "limit";

export interface AutoModeClassifierRequest {
  toolCallId: string;
  toolName: string;
  input: unknown;
  workingDirectory: string;
  traceContext: TraceContext;
  signal?: AbortSignal;
}

export interface AutoModeClassifierResult {
  outcome: AutoModeClassifierOutcome;
  /** 面向人和主模型的简短原因。 */
  reason: string;
  backend: string;
  stage?: string;
  latencyMs: number;
  cached?: boolean;
  /** unavailable / uncertain 时的处理方式，来自用户配置（onUnavailable / onUncertain）。 */
  fallback: "ask" | "deny";
}

export interface AutoModeClassifierPort {
  classify(request: AutoModeClassifierRequest): Promise<AutoModeClassifierResult>;
  /**
   * 用户在设置页配置的 auto 模式黑白名单，已解析为权限规则。
   * auto 模式下与项目规则合并后交给 PermissionService：deny 优先于一切放行，
   * allow 中「任意代码执行」类规则会被过滤。
   */
  resolveListRules(): Promise<Pick<PermissionRuleset, "allow" | "deny">>;
}

/**
 * 配置读取与审计写入的 I/O 边界，由 adapters 实现。
 * load 需要自行处理热加载（例如按 mtime），调用方每次判定前都会调用。
 */
export interface AutoModeSettingsPort {
  load(): Promise<AutoModeConfig>;
  appendAudit(entry: AutoModeAuditEntry): Promise<void>;
}
