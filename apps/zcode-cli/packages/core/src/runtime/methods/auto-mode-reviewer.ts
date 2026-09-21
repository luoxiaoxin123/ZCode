// ============================================================
// Runtime 装配：auto 模式审批器
// ============================================================
//
// 「跟随会话模型 / 已配置模型」两种来源都通过 runtime 的 modelFactory 创建模型，并在调用时带上
// refreshRuntimeHeadersBeforeAttempt：官方 Coding Plan 的网关改写与账号鉴权头因此与主循环一致，
// 智谱官方套餐与自定义 provider 都能直接用作审批模型。

import type { AutoModeClassifierPort, ModelSelection, TraceContext } from "@zcode/contracts";
import { runWithModelInvocationContext, traceContextToLogContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { AgentRuntimeDeps } from "../types.js";
import { createAutoModeClassifier } from "../../permission/auto-mode/classifier.js";
import type { ClassifierTextModel } from "../../permission/auto-mode/llm-backend.js";
import { createRefreshRuntimeHeadersBeforeModelAttempt } from "./model-runtime-headers.js";
import { createRuntimeModel } from "./runtime-model.js";

const MAX_INSTRUCTIONS_CHARS = 8_000;
const AUTO_MODE_MODEL_OPERATION = "tool_internal_model_call" as const;

export function createRuntimeAutoModeClassifier(
  runtime: AgentRuntimeInternal,
  deps: AgentRuntimeDeps,
): AutoModeClassifierPort {
  return createAutoModeClassifier({
    createRuntimeTextModel: (selection, traceContext) =>
      createRuntimeClassifierTextModel(runtime, selection, traceContext),
    getInstructions: () =>
      runtime.contextSourceSnapshot?.userInstructions?.content.slice(0, MAX_INSTRUCTIONS_CHARS),
    // 跨 await 使用，按接口约定做浅快照。
    getTranscriptEntries: () => [...runtime.messageHistory.borrowReadOnlyRuntimeEntries()],
    httpClientPort: deps.httpClientPort,
    logger: runtime.logger,
    sessionId: String(runtime.sessionId),
    settingsPort: deps.autoModeSettingsPort,
  });
}

function createRuntimeClassifierTextModel(
  runtime: AgentRuntimeInternal,
  requestedSelection: ModelSelection | undefined,
  traceContext: TraceContext,
): ClassifierTextModel | null {
  const selection = requestedSelection ?? runtime.getSessionModelSelection();
  if (!selection) return null;
  const baseModel = createRuntimeModel(runtime, { selection });
  return {
    label: `${baseModel.providerId}/${baseModel.modelId}`,
    async generate(request) {
      // 关闭思考（默认）：用公开档位的最低项，最快最省；开启：沿用该模型选择的默认档位。
      // 输出预算不超过模型上限。
      const maxOutputTokens = Math.min(
        request.maxOutputTokens,
        baseModel.optionSpecs.maxOutputTokens.max,
      );
      const model = baseModel.bind(
        request.thinking
          ? { maxOutputTokens }
          : { maxOutputTokens, reasoningLevel: baseModel.optionSpecs.reasoningLevel.values[0]! },
      );
      const invocationContext = {
        metadata: { ...traceContextToLogContext(traceContext), autoModeStage: request.stage },
        modelCall: {
          operation: AUTO_MODE_MODEL_OPERATION,
          reasoning: { requestedLevel: model.options.reasoningLevel },
        },
        modelRequestSessionType: "other" as const,
        refreshRuntimeHeadersBeforeAttempt: createRefreshRuntimeHeadersBeforeModelAttempt(runtime, {
          abortSignal: request.signal,
          model,
          traceContext,
        }),
        traceContext,
      };
      const result = await runWithModelInvocationContext(invocationContext, () =>
        model.generateText({
          abortSignal: request.signal,
          messages: [
            { content: request.system, role: "system" },
            { content: request.user, role: "user" },
          ],
          tools: [],
        }),
      );
      return result.text;
    },
  };
}
