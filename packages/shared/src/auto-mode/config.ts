import { z } from "zod";
import { modelSelectionSchema } from "../model-selection.js";

/**
 * Auto 模式配置（`~/.zcode/v2/auto-mode.json`）。
 *
 * 唯一写入者是桌面 Host 的 AutoModeConfigService；Agent 进程只读并按 mtime 热加载。
 * spec：docs/specs/auto-mode.md。
 */

export const AUTO_MODE_CONFIG_FILE_NAME = "auto-mode.json";
export const AUTO_MODE_AUDIT_FILE_NAME = "auto-mode-audit.jsonl";
/** Host 在 spawn Agent 时下发配置文件绝对路径；CLI 独立运行时回落到 `<data>/.zcode/v2`。 */
export const ZCODE_AUTO_MODE_CONFIG_FILE_ENV = "ZCODE_AUTO_MODE_CONFIG_FILE";

export const DEFAULT_TYPESAFE_BASE_URL = "https://api.typesafe.ai/v1";
export const DEFAULT_TYPESAFE_MODEL = "jev-latest";
export const DEFAULT_AUTO_MODE_TIMEOUT_MS = 30_000;
export const DEFAULT_TYPESAFE_THRESHOLD = 0.6;
export const DEFAULT_MAX_CONSECUTIVE_DENIALS = 3;
export const DEFAULT_MAX_TOTAL_DENIALS = 20;
const MIN_TIMEOUT_MS = 3_000;
const MAX_TIMEOUT_MS = 180_000;
const MIN_THRESHOLD = 0.5;
const MAX_THRESHOLD = 1;
const MAX_RULE_COUNT = 200;
const MAX_RULE_CHARS = 2_000;

export const autoModeBackendSchema = z.enum(["llm", "typesafe"]);
export type AutoModeBackend = z.infer<typeof autoModeBackendSchema>;

/**
 * - session：跟随当前会话模型（官方 Coding Plan 经 ZCode 网关，开箱即用）
 * - configured：从 ZCode 已配置的 Provider 中单独指定一个模型
 * - custom：独立端点（OpenAI 兼容 `/chat/completions` 或 Anthropic `/v1/messages`）
 */
export const autoModeLlmSourceSchema = z.enum(["session", "configured", "custom"]);
export type AutoModeLlmSource = z.infer<typeof autoModeLlmSourceSchema>;

export const autoModeCustomProtocolSchema = z.enum(["openai-compatible", "anthropic"]);
export type AutoModeCustomProtocol = z.infer<typeof autoModeCustomProtocolSchema>;

/**
 * 自定义端点如何表达「开/关思考」。各厂商参数不同：
 * - none：不发送任何思考参数（由 extraBody 自行控制）
 * - zhipu：`thinking: {type: "enabled"|"disabled"}`（智谱 / Z.ai）
 * - qwen：`chat_template_kwargs: {enable_thinking}`（Qwen、vLLM / SGLang 部署）
 * - openai：`reasoning_effort: "low"|"medium"`
 * - anthropic：`thinking: {type: "enabled", budget_tokens}`，关闭时不发送
 */
export const autoModeThinkingParamSchema = z.enum(["none", "zhipu", "qwen", "openai", "anthropic"]);
export type AutoModeThinkingParam = z.infer<typeof autoModeThinkingParamSchema>;

export const autoModeCustomEndpointSchema = z
  .object({
    protocol: autoModeCustomProtocolSchema.default("openai-compatible"),
    thinkingParam: autoModeThinkingParamSchema.default("none"),
    baseURL: z.string().trim().default(""),
    apiKey: z.string().default(""),
    model: z.string().trim().default(""),
    /** 深合并进请求体，例如 `{"chat_template_kwargs":{"enable_thinking":false}}`。 */
    extraBody: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type AutoModeCustomEndpoint = z.infer<typeof autoModeCustomEndpointSchema>;

const timeoutSchema = z.number().int().min(MIN_TIMEOUT_MS).max(MAX_TIMEOUT_MS);
const thresholdSchema = z.number().min(MIN_THRESHOLD).max(MAX_THRESHOLD);
const ruleListSchema = z.array(z.string().trim().min(1).max(MAX_RULE_CHARS)).max(MAX_RULE_COUNT);

export const autoModeLlmConfigSchema = z
  .object({
    source: autoModeLlmSourceSchema.default("session"),
    modelSelection: modelSelectionSchema.optional(),
    custom: autoModeCustomEndpointSchema.optional(),
    /** 两段式：先快速判定，非「放行」再带推理复核。关闭时只跑复核阶段。 */
    twoStage: z.boolean().default(true),
    /**
     * 审批模型是否开启思考。关闭（默认）更快、更省额度；开启后判定更稳但延迟更高。
     * 会话/已配置模型：关 = 最低推理档位，开 = 模型默认档位；自定义端点按 thinkingParam 注入。
     */
    thinking: z.boolean().default(false),
    timeoutMs: timeoutSchema.default(DEFAULT_AUTO_MODE_TIMEOUT_MS),
  })
  .strict();
export type AutoModeLlmConfig = z.infer<typeof autoModeLlmConfigSchema>;

export const autoModeTypeSafeConfigSchema = z
  .object({
    baseURL: z.string().trim().default(DEFAULT_TYPESAFE_BASE_URL),
    apiKey: z.string().default(""),
    model: z.string().trim().default(DEFAULT_TYPESAFE_MODEL),
    allowProb: thresholdSchema.default(DEFAULT_TYPESAFE_THRESHOLD),
    denyProb: thresholdSchema.default(DEFAULT_TYPESAFE_THRESHOLD),
    timeoutMs: timeoutSchema.default(DEFAULT_AUTO_MODE_TIMEOUT_MS),
  })
  .strict();
export type AutoModeTypeSafeConfig = z.infer<typeof autoModeTypeSafeConfigSchema>;

/** 用户规则：某一段非空时整段替换默认规则，为空时沿用默认。 */
export const autoModeRulesSchema = z
  .object({
    allow: ruleListSchema.default([]),
    soft_deny: ruleListSchema.default([]),
    environment: ruleListSchema.default([]),
  })
  .strict();
export type AutoModeRules = z.infer<typeof autoModeRulesSchema>;

/** ask = 回退到人工确认弹窗（默认），deny = 直接拒绝并把原因回给主模型。 */
export const autoModeFallbackSchema = z.enum(["ask", "deny"]);
export type AutoModeFallback = z.infer<typeof autoModeFallbackSchema>;

/**
 * auto 模式专属黑白名单，规则写法与 ZCode 权限规则一致：`Tool` 或 `Tool(content)`，
 * content 支持 `前缀:*` 与 `*` 通配，例如 `Bash(npm test:*)`、`Bash(git push:*)`、`WebFetch(domain:github.com)`。
 * deny 优先于一切放行（包括快速通道）；allow 中「任意代码执行」类规则会被忽略。
 */
const permissionRuleStringSchema = z.string().trim().min(1).max(MAX_RULE_CHARS);
export const autoModeListsSchema = z
  .object({
    allow: z.array(permissionRuleStringSchema).max(MAX_RULE_COUNT).default([]),
    deny: z.array(permissionRuleStringSchema).max(MAX_RULE_COUNT).default([]),
  })
  .strict();
export type AutoModeLists = z.infer<typeof autoModeListsSchema>;

export const autoModeDenialLimitsSchema = z
  .object({
    maxConsecutive: z.number().int().min(1).max(100).default(DEFAULT_MAX_CONSECUTIVE_DENIALS),
    maxTotal: z.number().int().min(1).max(1_000).default(DEFAULT_MAX_TOTAL_DENIALS),
  })
  .strict();
export type AutoModeDenialLimits = z.infer<typeof autoModeDenialLimitsSchema>;

export const autoModeConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    backend: autoModeBackendSchema.default("llm"),
    llm: autoModeLlmConfigSchema.default(() => autoModeLlmConfigSchema.parse({})),
    typesafe: autoModeTypeSafeConfigSchema.default(() => autoModeTypeSafeConfigSchema.parse({})),
    rules: autoModeRulesSchema.default(() => autoModeRulesSchema.parse({})),
    lists: autoModeListsSchema.default(() => autoModeListsSchema.parse({})),
    /** 审批器拿不准（LLM 输出 ask / TypeSafe 未过阈值）时的处理。 */
    onUncertain: autoModeFallbackSchema.default("ask"),
    /** 审批器故障（网络、鉴权、超时、未配置）时的处理。 */
    onUnavailable: autoModeFallbackSchema.default("ask"),
    denialLimits: autoModeDenialLimitsSchema.default(() => autoModeDenialLimitsSchema.parse({})),
  })
  .strict();
export type AutoModeConfig = z.infer<typeof autoModeConfigSchema>;

export function createDefaultAutoModeConfig(): AutoModeConfig {
  return autoModeConfigSchema.parse({});
}

/** 宽松解析：未知或非法内容回落默认值，并把错误交给调用方记录。 */
export function parseAutoModeConfig(raw: unknown): { config: AutoModeConfig; error?: string } {
  const result = autoModeConfigSchema.safeParse(raw ?? {});
  if (result.success) return { config: result.data };
  return {
    config: createDefaultAutoModeConfig(),
    error: result.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; "),
  };
}

/** 一条审批判定的审计记录（不含任何凭据）。 */
export const autoModeDecisionOutcomeSchema = z.enum([
  "allow",
  "block",
  "unavailable",
  "uncertain",
  "limit",
]);
export type AutoModeDecisionOutcome = z.infer<typeof autoModeDecisionOutcomeSchema>;

export const autoModeAuditEntrySchema = z
  .object({
    ts: z.string(),
    sessionId: z.string(),
    toolName: z.string(),
    snippet: z.string(),
    outcome: autoModeDecisionOutcomeSchema,
    backend: z.string(),
    stage: z.string().optional(),
    latencyMs: z.number(),
    reason: z.string(),
    cached: z.boolean().optional(),
  })
  .strict();
export type AutoModeAuditEntry = z.infer<typeof autoModeAuditEntrySchema>;
