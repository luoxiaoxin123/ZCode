// ============================================================
// Auto 模式审批器：配置 → 对话摘要 → 缓存 → 后端（LLM / TypeSafe）→ 拦截计数 → 审计
// ============================================================
//
// 与运行时解耦：会话模型通过 createSessionTextModel 注入，外部 I/O 通过端口注入。
// spec：docs/specs/auto-mode.md。

import { createHash } from "node:crypto";
import type {
  AutoModeClassifierPort,
  AutoModeClassifierRequest,
  AutoModeClassifierResult,
  AutoModeSettingsPort,
  HttpClientPort,
  Logger,
  ModelSelection,
  PermissionRuleValue,
  TraceContext,
} from "@zcode/contracts";
import {
  createDefaultAutoModeConfig,
  parseAutoModeListRule,
  type AutoModeAuditEntry,
  type AutoModeConfig,
} from "@zcode/shared/auto-mode";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import { createCustomEndpointTextModel, validateCustomEndpoint } from "./custom-endpoint.js";
import { AutoModeDenialTracker } from "./denial-tracking.js";
import { classifyWithLlm, type ClassifierTextModel } from "./llm-backend.js";
import { buildAutoModeSystemPrompt } from "./prompt.js";
import { buildAutoModeTranscript, formatActionLine, projectToolInput } from "./transcript.js";
import { classifyWithTypeSafe } from "./typesafe-backend.js";

const CACHE_TTL_MS = 15 * 60_000;
const CACHE_MAX_ENTRIES = 200;
const AUDIT_SNIPPET_CHARS = 300;
const OUTPUT_FORMAT_HEADING = "\n## Output format";

export interface AutoModeClassifierDeps {
  sessionId: string;
  settingsPort?: AutoModeSettingsPort;
  httpClientPort?: HttpClientPort;
  logger?: Logger;
  /** 当前会话的 provider 可见历史（只读快照）。 */
  getTranscriptEntries(): readonly RuntimeMessageEntry[];
  /** 已加载的项目指令（AGENTS.md 等），作为用户意图的一部分。 */
  getInstructions?(): string | undefined;
  /**
   * 用 ZCode 自己的 model runtime 构造审批模型：selection 为空表示跟随会话模型。
   * 官方 Coding Plan 的网关与鉴权头由这条链路负责。返回 null 表示当前没有可用模型。
   */
  createRuntimeTextModel(
    selection: ModelSelection | undefined,
    traceContext: TraceContext,
  ): ClassifierTextModel | null;
  now?: () => number;
}

interface CachedVerdict {
  expiresAt: number;
  outcome: "allow" | "block";
  reason: string;
  backend: string;
  stage?: string;
}

interface BackendVerdict {
  outcome: AutoModeClassifierResult["outcome"];
  reason: string;
  backend: string;
  stage?: string;
}

export function createAutoModeClassifier(deps: AutoModeClassifierDeps): AutoModeClassifierPort {
  const cache = new Map<string, CachedVerdict>();
  const denials = new AutoModeDenialTracker();
  const now = deps.now ?? Date.now;

  async function loadConfig(): Promise<AutoModeConfig> {
    if (!deps.settingsPort) return createDefaultAutoModeConfig();
    try {
      return await deps.settingsPort.load();
    } catch (error) {
      deps.logger?.warn("Auto mode config load failed; using defaults", {
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "auto_mode.config.load_failed",
        module: "core.permission.auto_mode",
      });
      return createDefaultAutoModeConfig();
    }
  }

  async function runBackend(
    config: AutoModeConfig,
    request: AutoModeClassifierRequest,
    transcript: ReturnType<typeof buildAutoModeTranscript>,
    actionLine: string,
  ): Promise<BackendVerdict> {
    const systemPrompt = buildAutoModeSystemPrompt(config.rules);
    if (config.backend === "typesafe") {
      if (!deps.httpClientPort) throw new Error("HTTP client is not available");
      const verdict = await classifyWithTypeSafe({
        config: config.typesafe,
        currentTask: transcript.recentUserMessages.join("\n---\n"),
        httpClientPort: deps.httpClientPort,
        recentActions: transcript.recentActions,
        reviewerPolicy: stripOutputFormat(systemPrompt),
        signal: request.signal,
        toolInput: request.input,
        toolName: request.toolName,
        traceContext: request.traceContext,
        workingDirectory: request.workingDirectory,
      });
      return { ...verdict, backend: "typesafe" };
    }

    const model = resolveTextModel(config, request.traceContext);
    const timeoutSignal = AbortSignal.timeout(config.llm.timeoutMs * (config.llm.twoStage ? 2 : 1));
    const signal = request.signal
      ? AbortSignal.any([request.signal, timeoutSignal])
      : timeoutSignal;
    const verdict = await classifyWithLlm({
      actionLine,
      instructions: deps.getInstructions?.(),
      model,
      signal,
      systemPrompt,
      thinking: config.llm.thinking,
      transcriptLines: transcript.lines,
      twoStage: config.llm.twoStage,
      workingDirectory: request.workingDirectory,
    });
    return { ...verdict, backend: `llm:${model.label}` };
  }

  function resolveTextModel(
    config: AutoModeConfig,
    traceContext: TraceContext,
  ): ClassifierTextModel {
    const { llm } = config;
    if (llm.source === "custom") {
      const problem = validateCustomEndpoint(llm.custom);
      if (problem) throw new Error(problem);
      if (!deps.httpClientPort) throw new Error("HTTP client is not available");
      return createCustomEndpointTextModel({
        endpoint: llm.custom!,
        httpClientPort: deps.httpClientPort,
        timeoutMs: llm.timeoutMs,
        traceContext,
      });
    }
    const selection = llm.source === "configured" ? llm.modelSelection : undefined;
    if (llm.source === "configured" && !selection) {
      throw new Error("no reviewer model selected in auto mode settings");
    }
    const model = deps.createRuntimeTextModel(selection, traceContext);
    if (!model) throw new Error("no model is available for the auto mode reviewer");
    return model;
  }

  function recordAudit(entry: AutoModeAuditEntry): void {
    if (!deps.settingsPort) return;
    void deps.settingsPort.appendAudit(entry).catch((error: unknown) => {
      deps.logger?.debug("Auto mode audit append failed", {
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "auto_mode.audit.append_failed",
        module: "core.permission.auto_mode",
      });
    });
  }

  return {
    async resolveListRules() {
      const { lists } = await loadConfig();
      return {
        allow: parseListRules(lists.allow),
        deny: parseListRules(lists.deny),
      };
    },

    async classify(request) {
      const startedAt = now();
      const config = await loadConfig();
      const transcript = buildAutoModeTranscript(deps.getTranscriptEntries());
      const actionLine = formatActionLine({ input: request.input, toolName: request.toolName });
      const cacheKey = hashKey([
        config.backend,
        config.backend === "llm" ? config.llm.source : config.typesafe.model,
        // 规则或思考开关变化后旧判定不再适用。
        JSON.stringify([config.rules, config.llm.thinking]),
        transcript.recentUserMessages.at(-1) ?? "",
        request.workingDirectory,
        actionLine,
      ]);

      let verdict: BackendVerdict;
      let cached = false;
      const hit = cache.get(cacheKey);
      if (hit && hit.expiresAt > now()) {
        verdict = {
          backend: hit.backend,
          outcome: hit.outcome,
          reason: hit.reason,
          stage: hit.stage,
        };
        cached = true;
      } else {
        try {
          verdict = await runBackend(config, request, transcript, actionLine);
        } catch (error) {
          verdict = {
            backend: config.backend,
            outcome: "unavailable",
            reason: error instanceof Error ? error.message : String(error),
          };
        }
        if (verdict.outcome === "allow" || verdict.outcome === "block") {
          rememberVerdict(cache, cacheKey, {
            backend: verdict.backend,
            expiresAt: now() + CACHE_TTL_MS,
            outcome: verdict.outcome,
            reason: verdict.reason,
            stage: verdict.stage,
          });
        }
      }

      let outcome = verdict.outcome;
      let reason = verdict.reason;
      if (outcome === "allow") {
        denials.recordAllow();
      } else if (outcome === "block") {
        denials.recordBlock();
        const limitReason = denials.consumeLimit(config.denialLimits);
        if (limitReason) {
          outcome = "limit";
          reason = `${limitReason} Latest blocked action: ${reason}`;
        }
      }

      const result: AutoModeClassifierResult = {
        backend: verdict.backend,
        cached,
        fallback: outcome === "uncertain" ? config.onUncertain : config.onUnavailable,
        latencyMs: Math.max(0, now() - startedAt),
        outcome,
        reason,
        ...(verdict.stage ? { stage: verdict.stage } : {}),
      };
      recordAudit({
        backend: result.backend,
        cached,
        latencyMs: result.latencyMs,
        outcome,
        reason,
        sessionId: deps.sessionId,
        snippet: projectToolInput(request.toolName, request.input).slice(0, AUDIT_SNIPPET_CHARS),
        toolName: request.toolName,
        ts: new Date(startedAt).toISOString(),
        ...(verdict.stage ? { stage: verdict.stage } : {}),
      });
      return result;
    },
  };
}

function rememberVerdict(cache: Map<string, CachedVerdict>, key: string, value: CachedVerdict) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** 设置页的规则字符串；无法解析的条目忽略（GUI 保存前已校验）。 */
function parseListRules(rules: readonly string[]): PermissionRuleValue[] {
  return rules
    .map((raw) => parseAutoModeListRule(raw))
    .filter((rule): rule is PermissionRuleValue => rule !== null);
}

function hashKey(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join(" ")).digest("hex").slice(0, 32);
}

/** TypeSafe 不输出文本，去掉面向 LLM 的输出格式段。 */
function stripOutputFormat(prompt: string): string {
  const index = prompt.indexOf(OUTPUT_FORMAT_HEADING);
  return index >= 0 ? prompt.slice(0, index).trim() : prompt;
}
