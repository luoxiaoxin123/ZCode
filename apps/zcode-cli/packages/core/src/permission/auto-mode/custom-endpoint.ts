// 自定义端点审批模型：OpenAI 兼容 `/chat/completions` 或 Anthropic `/v1/messages`。
// 用于不想占用会话模型额度、或想用专门小模型做审批的场景。
import type { HttpClientPort, TraceContext } from "@zcode/contracts";
import type { AutoModeCustomEndpoint } from "@zcode/shared/auto-mode";
import { deepMerge, isPlainObject, joinUrl, postJsonWithRetry } from "./http-json.js";
import type { ClassifierTextModel, ClassifierTextRequest } from "./llm-backend.js";

const ANTHROPIC_VERSION = "2023-06-01";
const CHAT_COMPLETIONS_PATH = "/chat/completions";
const ANTHROPIC_MESSAGES_PATH = "/messages";

export function resolveCustomEndpointUrl(endpoint: AutoModeCustomEndpoint): string {
  const base = endpoint.baseURL.trim().replace(/\/+$/u, "");
  if (endpoint.protocol === "anthropic") {
    if (base.endsWith(ANTHROPIC_MESSAGES_PATH)) return base;
    // 允许填写 `https://host/api/anthropic` 或 `https://host/api/anthropic/v1`。
    return base.endsWith("/v1")
      ? joinUrl(base, ANTHROPIC_MESSAGES_PATH)
      : joinUrl(base, `/v1${ANTHROPIC_MESSAGES_PATH}`);
  }
  return base.endsWith(CHAT_COMPLETIONS_PATH) ? base : joinUrl(base, CHAT_COMPLETIONS_PATH);
}

export function validateCustomEndpoint(
  endpoint: AutoModeCustomEndpoint | undefined,
): string | null {
  if (!endpoint) return "custom endpoint is not configured";
  if (!/^https?:\/\//iu.test(endpoint.baseURL.trim())) return "custom endpoint base URL is invalid";
  if (!endpoint.model.trim()) return "custom endpoint model is empty";
  return null;
}

export function createCustomEndpointTextModel(input: {
  endpoint: AutoModeCustomEndpoint;
  httpClientPort: HttpClientPort;
  timeoutMs: number;
  traceContext: TraceContext;
}): ClassifierTextModel {
  const { endpoint } = input;
  const url = resolveCustomEndpointUrl(endpoint);
  return {
    label: `custom/${endpoint.model}`,
    async generate(request: ClassifierTextRequest): Promise<string> {
      const isAnthropic = endpoint.protocol === "anthropic";
      const baseBody: Record<string, unknown> = isAnthropic
        ? {
            max_tokens: request.maxOutputTokens,
            messages: [{ content: request.user, role: "user" }],
            model: endpoint.model,
            system: request.system,
            temperature: 0,
          }
        : {
            max_tokens: request.maxOutputTokens,
            messages: [
              { content: request.system, role: "system" },
              { content: request.user, role: "user" },
            ],
            model: endpoint.model,
            temperature: 0,
          };
      const withThinking = applyThinkingParam(baseBody, endpoint, request);
      const body = endpoint.extraBody ? deepMerge(withThinking, endpoint.extraBody) : withThinking;
      const headers: Record<string, string> = isAnthropic
        ? {
            "anthropic-version": ANTHROPIC_VERSION,
            ...(endpoint.apiKey
              ? { authorization: `Bearer ${endpoint.apiKey}`, "x-api-key": endpoint.apiKey }
              : {}),
          }
        : endpoint.apiKey
          ? { authorization: `Bearer ${endpoint.apiKey}` }
          : {};
      const json = await postJsonWithRetry({
        body,
        headers,
        httpClientPort: input.httpClientPort,
        signal: request.signal,
        timeoutMs: input.timeoutMs,
        traceContext: input.traceContext,
        url,
      });
      return isAnthropic ? readAnthropicText(json) : readOpenAiText(json);
    },
  };
}

const ANTHROPIC_MIN_THINKING_BUDGET = 1_024;
const OPENAI_REASONING_EFFORT_ON = "medium";
const OPENAI_REASONING_EFFORT_OFF = "low";

/**
 * 按厂商写法注入「开/关思考」。extraBody 在其后深合并，用户可以覆盖这里的任何字段。
 * 导出供测试。
 */
export function applyThinkingParam(
  body: Record<string, unknown>,
  endpoint: AutoModeCustomEndpoint,
  request: Pick<ClassifierTextRequest, "thinking" | "maxOutputTokens">,
): Record<string, unknown> {
  switch (endpoint.thinkingParam) {
    case "zhipu":
      return { ...body, thinking: { type: request.thinking ? "enabled" : "disabled" } };
    case "qwen":
      return { ...body, chat_template_kwargs: { enable_thinking: request.thinking } };
    case "openai":
      return {
        ...body,
        reasoning_effort: request.thinking
          ? OPENAI_REASONING_EFFORT_ON
          : OPENAI_REASONING_EFFORT_OFF,
      };
    case "anthropic": {
      if (!request.thinking) return body;
      // Anthropic 开启 extended thinking 时不能指定 temperature，且 max_tokens 必须大于预算。
      const { temperature: _temperature, ...rest } = body;
      const budget = Math.max(
        ANTHROPIC_MIN_THINKING_BUDGET,
        Math.floor(request.maxOutputTokens / 2),
      );
      return {
        ...rest,
        max_tokens: Math.max(request.maxOutputTokens, budget + ANTHROPIC_MIN_THINKING_BUDGET),
        thinking: { budget_tokens: budget, type: "enabled" },
      };
    }
    case "none":
      return body;
  }
}

function readOpenAiText(json: unknown): string {
  if (!isPlainObject(json) || !Array.isArray(json.choices)) return "";
  const first = json.choices[0];
  if (!isPlainObject(first) || !isPlainObject(first.message)) return "";
  const content = first.message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (isPlainObject(part) && typeof part.text === "string" ? part.text : ""))
      .join("");
  }
  return "";
}

function readAnthropicText(json: unknown): string {
  if (!isPlainObject(json) || !Array.isArray(json.content)) return "";
  return json.content
    .map((block) =>
      isPlainObject(block) && block.type === "text" && typeof block.text === "string"
        ? block.text
        : "",
    )
    .join("");
}
