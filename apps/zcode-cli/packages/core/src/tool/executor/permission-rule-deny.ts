import {
  traceContextToLogContext,
  type CollaborationMode,
  type ToolExecutionSpanWriter,
  type TraceContext,
} from "@zcode/contracts";
import type { PermissionDecisionResult } from "../../permission/service.js";
import type { ExecutableToolCall, ToolExecutionResult } from "../types.js";
import { createPermissionErrorResult } from "./errors.js";
import { emitPermissionDenied } from "./events.js";
import type { ToolExecutorDeps } from "./types.js";

/**
 * PermissionService 直接给出 deny 时的收尾：发 PermissionDenied 事件、记日志、构造错误结果。
 * 从 permission-flow.ts 原样拆出（该文件接入 auto 模式后超过 400 行上限）。
 */
export async function denyByPermissionDecision(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  permissionDecision: PermissionDecisionResult,
  mode: CollaborationMode,
  traceContext: TraceContext,
  telemetry?: ToolExecutionSpanWriter,
): Promise<{ allowed: false; result: ToolExecutionResult }> {
  telemetry?.setPermissionDecision("denied");
  await emitPermissionDenied(deps, toolCall, permissionDecision.reason, traceContext);

  deps.logger?.warn("Tool permission denied", {
    ...traceContextToLogContext(traceContext),
    decision: permissionDecision.decision,
    event: "tool.permission.denied",
    mode,
    module: "core.tool.executor",
    reason: permissionDecision.reason,
    ruleId: permissionDecision.ruleId,
    status: "failed",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
  });
  return {
    allowed: false,
    result: createPermissionErrorResult(toolCall, permissionDecision.reason, {
      decision: permissionDecision.decision,
      mode,
      ruleId: permissionDecision.ruleId,
    }),
  };
}
