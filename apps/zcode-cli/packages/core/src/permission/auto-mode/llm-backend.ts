// LLM 审批后端：两段式（fast → thinking）XML 判定。
import { buildAutoModeUserPrompt, parseClassifierVerdict, type ClassifierStage } from "./prompt.js";

export interface ClassifierTextRequest {
  system: string;
  user: string;
  maxOutputTokens: number;
  stage: ClassifierStage;
  /** 用户是否为审批模型开启思考；由具体模型实现翻译成各自的参数。 */
  thinking: boolean;
  signal: AbortSignal;
}

/** 审批器使用的最小模型接口：给定 system/user，返回纯文本。 */
export interface ClassifierTextModel {
  readonly label: string;
  generate(request: ClassifierTextRequest): Promise<string>;
}

export interface LlmVerdict {
  outcome: "allow" | "block" | "uncertain";
  reason: string;
  stage: ClassifierStage;
}

export const FAST_STAGE_MAX_OUTPUT_TOKENS = 256;
/** 开启思考时 stage 1 也会先输出推理内容，预算太小会被截断成无法解析。 */
export const FAST_STAGE_THINKING_MAX_OUTPUT_TOKENS = 4_096;
export const THINKING_STAGE_MAX_OUTPUT_TOKENS = 4_096;
export const THINKING_STAGE_THINKING_MAX_OUTPUT_TOKENS = 8_192;
const UNPARSEABLE_REASON = "Reviewer response could not be parsed - blocking for safety";
const DEFAULT_BLOCK_REASON = "Blocked by the auto mode reviewer";
const DEFAULT_UNSURE_REASON = "The reviewer could not decide";

export async function classifyWithLlm(input: {
  model: ClassifierTextModel;
  systemPrompt: string;
  transcriptLines: readonly string[];
  actionLine: string;
  workingDirectory: string;
  instructions?: string;
  twoStage: boolean;
  thinking: boolean;
  signal: AbortSignal;
}): Promise<LlmVerdict> {
  const buildUser = (stage: ClassifierStage) =>
    buildAutoModeUserPrompt({
      actionLine: input.actionLine,
      instructions: input.instructions,
      stage,
      transcriptLines: input.transcriptLines,
      workingDirectory: input.workingDirectory,
    });

  let fastReason: string | undefined;
  if (input.twoStage) {
    const fastText = await input.model.generate({
      maxOutputTokens: input.thinking
        ? FAST_STAGE_THINKING_MAX_OUTPUT_TOKENS
        : FAST_STAGE_MAX_OUTPUT_TOKENS,
      signal: input.signal,
      stage: "fast",
      system: input.systemPrompt,
      thinking: input.thinking,
      user: buildUser("fast"),
    });
    const fast = parseClassifierVerdict(fastText);
    // 只有明确放行才采信 stage 1；拦截、拿不准或解析失败都进入复核，减少误拦与误弹窗。
    if (fast.block === false) {
      return { outcome: "allow", reason: "Allowed by fast review", stage: "fast" };
    }
    if (fast.block === true) fastReason = fast.reason ?? DEFAULT_BLOCK_REASON;
  }

  let thinkingText: string;
  try {
    thinkingText = await input.model.generate({
      maxOutputTokens: input.thinking
        ? THINKING_STAGE_THINKING_MAX_OUTPUT_TOKENS
        : THINKING_STAGE_MAX_OUTPUT_TOKENS,
      signal: input.signal,
      stage: "thinking",
      system: input.systemPrompt,
      thinking: input.thinking,
      user: buildUser("thinking"),
    });
  } catch (error) {
    // stage 1 已明确拦截时，复核失败按 stage 1 结论拦截；否则视为不可用。
    if (fastReason) return { outcome: "block", reason: fastReason, stage: "fast" };
    throw error;
  }
  const verdict = parseClassifierVerdict(thinkingText);
  if (verdict.block === null) {
    return { outcome: "block", reason: UNPARSEABLE_REASON, stage: "thinking" };
  }
  if (verdict.block === "ask") {
    return {
      outcome: "uncertain",
      reason: verdict.reason ?? DEFAULT_UNSURE_REASON,
      stage: "thinking",
    };
  }
  if (verdict.block) {
    return { outcome: "block", reason: verdict.reason ?? DEFAULT_BLOCK_REASON, stage: "thinking" };
  }
  return { outcome: "allow", reason: "Allowed by review", stage: "thinking" };
}
