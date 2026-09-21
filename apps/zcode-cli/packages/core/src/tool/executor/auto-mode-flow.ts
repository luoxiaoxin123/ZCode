import {
  traceContextToLogContext,
  type AutoModeClassifierResult,
  type CollaborationMode,
  type PermissionRuleset,
  type ToolExecutionSpanWriter,
  type TraceContext,
} from "@zcode/contracts";
import {
  AUTO_MODE_CLASSIFIER_RULE_ID,
  type PermissionDecisionResult,
} from "../../permission/service.js";
import type { ExecutableToolCall, ToolExecutionResult } from "../types.js";
import { createPermissionErrorResult } from "./errors.js";
import { emitPermissionDenied } from "./events.js";
import type { ToolExecutorDeps } from "./types.js";

/**
 * auto 模式审批：PermissionService 已经把确定性规则走完，剩下标记为 classifierEligible 的 ask
 * 在这里交给审批器。结果三选一：直接放行、拦截并把原因回给主模型、回退到人工确认弹窗。
 *
 * 失败语义是 fail-closed：审批器异常、不可用、拿不准都不会放行，按用户配置回退到弹窗或拒绝。
 * spec：docs/specs/auto-mode.md。
 */
export type AutoModeFlowResult =
  | { kind: "allow" }
  | { kind: "deny"; result: ToolExecutionResult }
  | { kind: "ask"; reason: string };

const LOG_MODULE = "core.tool.executor";

/** 把 auto 模式黑白名单追加到项目规则（不修改入参，不落盘）。 */
export function mergeAutoModeListRules(
  projectRules: PermissionRuleset | null,
  lists: Pick<PermissionRuleset, "allow" | "deny">,
): PermissionRuleset | null {
  const allow = lists.allow ?? [];
  const deny = lists.deny ?? [];
  if (allow.length === 0 && deny.length === 0) return projectRules;
  const base: PermissionRuleset = projectRules ?? { version: 1 };
  return {
    ...base,
    allow: [...(base.allow ?? []), ...allow],
    deny: [...(base.deny ?? []), ...deny],
  };
}

/** auto 模式：设置页的黑白名单并入项目规则，沿用 PermissionService 的优先级与复合命令判定。 */
export async function loadAutoModeListRules(
  deps: ToolExecutorDeps,
  mode: CollaborationMode,
  projectRules: PermissionRuleset | null,
): Promise<PermissionRuleset | null> {
  if (mode !== "auto" || !deps.autoModeClassifier) return projectRules;
  return mergeAutoModeListRules(projectRules, await deps.autoModeClassifier.resolveListRules());
}

/** 闸门的终态：直接放行或拒绝（与 permission-flow 的结果同形）。 */
export type AutoModeGateFinal =
  | { allowed: true; executionInput: unknown }
  | { allowed: false; result: ToolExecutionResult };

/**
 * permission-flow 的 auto 模式闸门：确定性规则之后的 ask 先交给审批器，只有它回退时才弹窗。
 * 只处理 classifierEligible 的 ask；其余决定原样返回（可能带上审批器给的原因），由原有弹窗流程处理。
 */
export async function runAutoModeGate(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  executionInput: unknown,
  permissionDecision: PermissionDecisionResult,
  context: {
    mode: CollaborationMode;
    traceContext: TraceContext;
    signal?: AbortSignal;
    telemetry?: ToolExecutionSpanWriter;
  },
): Promise<AutoModeGateFinal | PermissionDecisionResult> {
  const { mode, signal, telemetry, traceContext } = context;
  if (
    mode !== "auto" ||
    permissionDecision.decision !== "ask" ||
    permissionDecision.classifierEligible !== true
  ) {
    return permissionDecision;
  }
  const outcome = await resolveAutoModeClassification(
    deps,
    toolCall,
    executionInput,
    permissionDecision,
    mode,
    traceContext,
    signal,
  );
  if (outcome.kind === "allow") {
    telemetry?.setPermissionDecision("granted");
    return { allowed: true, executionInput };
  }
  if (outcome.kind === "deny") {
    telemetry?.setPermissionDecision("denied");
    return { allowed: false, result: outcome.result };
  }
  return { ...permissionDecision, reason: outcome.reason };
}

export async function resolveAutoModeClassification(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  executionInput: unknown,
  permissionDecision: PermissionDecisionResult,
  mode: CollaborationMode,
  traceContext: TraceContext,
  signal?: AbortSignal,
): Promise<AutoModeFlowResult> {
  const classifier = deps.autoModeClassifier;
  if (!classifier) {
    return {
      kind: "ask",
      reason: permissionDecision.reason ?? "Auto mode reviewer is not configured",
    };
  }

  let verdict: AutoModeClassifierResult;
  try {
    verdict = await classifier.classify({
      input: executionInput,
      signal,
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      traceContext,
      workingDirectory: deps.getWorkingDirectory(),
    });
  } catch (error) {
    // 审批器实现应自行把错误归一为 unavailable；这里兜住未预期异常，保持 fail-closed。
    verdict = {
      backend: "unknown",
      fallback: "ask",
      latencyMs: 0,
      outcome: "unavailable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  deps.logger?.info("Auto mode reviewer decided", {
    ...traceContextToLogContext(traceContext),
    backend: verdict.backend,
    cached: verdict.cached === true,
    event: "tool.permission.auto_mode.decided",
    latencyMs: verdict.latencyMs,
    module: LOG_MODULE,
    outcome: verdict.outcome,
    stage: verdict.stage,
    status: verdict.outcome === "allow" ? "completed" : "waiting",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
  });

  switch (verdict.outcome) {
    case "allow":
      return { kind: "allow" };
    case "block":
      return {
        kind: "deny",
        result: await denyToolCall(
          deps,
          toolCall,
          buildAutoModeRejectionMessage(verdict.reason),
          verdict,
          mode,
          traceContext,
        ),
      };
    case "limit":
      return { kind: "ask", reason: verdict.reason };
    case "unavailable":
    case "uncertain":
      if (verdict.fallback === "deny") {
        return {
          kind: "deny",
          result: await denyToolCall(
            deps,
            toolCall,
            verdict.outcome === "uncertain"
              ? buildAutoModeUncertainMessage(toolCall.name, verdict)
              : buildAutoModeUnavailableMessage(toolCall.name, verdict),
            verdict,
            mode,
            traceContext,
          ),
        };
      }
      return {
        kind: "ask",
        reason:
          verdict.outcome === "uncertain"
            ? `Auto mode reviewer is unsure: ${verdict.reason}`
            : `Auto mode reviewer unavailable: ${verdict.reason}`,
      };
  }
}

async function denyToolCall(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  message: string,
  verdict: AutoModeClassifierResult,
  mode: CollaborationMode,
  traceContext: TraceContext,
): Promise<ToolExecutionResult> {
  await emitPermissionDenied(deps, toolCall, message, traceContext);
  deps.logger?.warn("Tool permission denied by auto mode reviewer", {
    ...traceContextToLogContext(traceContext),
    backend: verdict.backend,
    event: "tool.permission.auto_mode.denied",
    module: LOG_MODULE,
    outcome: verdict.outcome,
    status: "failed",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
  });
  return createPermissionErrorResult(toolCall, message, {
    autoModeBackend: verdict.backend,
    autoModeOutcome: verdict.outcome,
    decision: "deny",
    mode,
    ruleId: AUTO_MODE_CLASSIFIER_RULE_ID,
  });
}

/** 回给主模型的拦截说明：允许合理替代，禁止绕过意图，必要时停下来问用户。 */
export function buildAutoModeRejectionMessage(reason: string): string {
  return [
    `Permission for this action was denied by the auto mode reviewer. Reason: ${reason}`,
    "If other parts of the task do not depend on this action, continue with them.",
    "You may use a different, reasonable approach that achieves the same goal (for example a read-only alternative), but do not try to work around the intent of this denial, e.g. by wrapping the same action in a script, test or another tool.",
    "If this action is essential, stop and explain to the user what you want to do and why, so they can approve it manually or change the permission mode.",
  ].join(" ");
}

function buildAutoModeUncertainMessage(
  toolName: string,
  verdict: AutoModeClassifierResult,
): string {
  return [
    `The auto mode reviewer could not confidently approve ${toolName} (${verdict.reason}), so the action was not executed.`,
    "If the action is necessary, explain to the user what you want to do and why so they can approve it; otherwise continue with other work.",
  ].join(" ");
}

function buildAutoModeUnavailableMessage(
  toolName: string,
  verdict: AutoModeClassifierResult,
): string {
  return [
    `The auto mode reviewer could not approve ${toolName} right now (${verdict.reason}), so the action was not executed.`,
    "Wait briefly and retry, or continue with other work. Reading files, searching code and other read-only operations do not need the reviewer.",
  ].join(" ");
}
