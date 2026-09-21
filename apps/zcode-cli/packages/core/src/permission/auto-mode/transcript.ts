// ============================================================
// Auto 模式审批器的对话摘要
// ============================================================
//
// 审批器只看「用户说了什么」和「agent 之前做过什么动作」：
// - 保留：真实用户输入的文字、assistant 发起的工具调用（投影成紧凑的一行）。
// - 丢弃：assistant 的自然语言、工具结果、system reminder 等。它们可能被模型或外部内容操纵，
//   用来诱导审批器放行（prompt injection）。
// 每行一个 JSON 对象（JSONL），用户文字里的换行/引号被转义，无法伪造出新的一行 user 记录。

import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import { modelMessageContentToText } from "@zcode/contracts";

export const AUTO_MODE_TRANSCRIPT_CHAR_BUDGET = 40_000;
const MAX_USER_MESSAGE_CHARS = 4_000;
const MAX_FIELD_CHARS = 2_000;
const MAX_RECENT_ACTIONS = 10;
const MAX_RECENT_USER_MESSAGES = 5;
const REAL_USER_SOURCE = "real_user";

const SHELL_TOOLS = new Set(["Bash", "Shell", "PowerShell"]);
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

export interface AutoModeTranscript {
  /** JSONL 行，按时间顺序。 */
  lines: string[];
  /** 最近几条真实用户消息（新在后）。 */
  recentUserMessages: string[];
  /** 最近几次工具调用的紧凑描述（新在后）。 */
  recentActions: string[];
}

export interface AutoModeAction {
  toolName: string;
  input: unknown;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…[truncated ${text.length - max} chars]` : text;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

/** 把工具输入投影成审批器关心的一段文本。 */
export function projectToolInput(toolName: string, input: unknown): string {
  if (input === null || input === undefined) return "";
  if (typeof input !== "object") return truncate(String(input), MAX_FIELD_CHARS);
  const record = input as Record<string, unknown>;
  if (SHELL_TOOLS.has(toolName)) {
    const command = readString(record, "command");
    if (command !== undefined) return truncate(command, MAX_FIELD_CHARS);
  }
  if (WRITE_TOOLS.has(toolName)) {
    const path =
      readString(record, "file_path") ??
      readString(record, "path") ??
      readString(record, "notebook_path") ??
      "";
    const body =
      readString(record, "content") ??
      readString(record, "new_string") ??
      readString(record, "new_source") ??
      "";
    return truncate(`${path}: ${body}`, MAX_FIELD_CHARS);
  }
  if (toolName === "WebFetch") {
    const url = readString(record, "url") ?? "";
    const prompt = readString(record, "prompt");
    return truncate(prompt ? `${url}: ${prompt}` : url, MAX_FIELD_CHARS);
  }
  if (toolName.startsWith("mcp__")) {
    const pairs = Object.entries(record).map(
      ([key, value]) => `${key}=${typeof value === "string" ? value : safeJson(value)}`,
    );
    return truncate(pairs.join(" "), MAX_FIELD_CHARS);
  }
  return truncate(safeJson(record), MAX_FIELD_CHARS);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

function isRealUserEntry(entry: RuntimeMessageEntry, hasSourceMetadata: boolean): boolean {
  if (entry.kind === "attachment") return false;
  if (entry.message.role !== "user") return false;
  // 旧会话没有来源元数据时，把所有 user 消息当作用户输入；否则只认真实用户输入。
  return hasSourceMetadata ? entry.metadata?.source === REAL_USER_SOURCE : true;
}

export function formatActionLine(action: AutoModeAction): string {
  return JSON.stringify({ [action.toolName]: projectToolInput(action.toolName, action.input) });
}

export function buildAutoModeTranscript(
  entries: readonly RuntimeMessageEntry[],
  budget: number = AUTO_MODE_TRANSCRIPT_CHAR_BUDGET,
): AutoModeTranscript {
  const hasSourceMetadata = entries.some(
    (entry) => entry.kind !== "attachment" && entry.metadata?.source === REAL_USER_SOURCE,
  );
  const lines: { text: string; isUser: boolean }[] = [];
  const recentUserMessages: string[] = [];
  const recentActions: string[] = [];

  for (const entry of entries) {
    if (entry.kind === "attachment") continue;
    const message = entry.message;
    if (isRealUserEntry(entry, hasSourceMetadata)) {
      const text = modelMessageContentToText(message.content).trim();
      if (!text) continue;
      const clipped = truncate(text, MAX_USER_MESSAGE_CHARS);
      lines.push({ text: JSON.stringify({ user: clipped }), isUser: true });
      recentUserMessages.push(clipped);
      continue;
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      for (const toolCall of message.toolCalls) {
        const action = { toolName: toolCall.name, input: toolCall.input };
        lines.push({ text: formatActionLine(action), isUser: false });
        recentActions.push(`${toolCall.name}: ${projectToolInput(toolCall.name, toolCall.input)}`);
      }
    }
  }

  return {
    lines: trimToBudget(lines, budget),
    recentUserMessages: recentUserMessages.slice(-MAX_RECENT_USER_MESSAGES),
    recentActions: recentActions.slice(-MAX_RECENT_ACTIONS).map((line) => truncate(line, 400)),
  };
}

/** 从尾部保留行直到预算用完；最近一条用户消息无论如何都保留。 */
function trimToBudget(lines: { text: string; isUser: boolean }[], budget: number): string[] {
  const kept: string[] = [];
  let used = 0;
  let keptUser = false;
  let full = false;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    const cost = line.text.length + 1;
    if (full || used + cost > budget) {
      full = true;
      if (keptUser) break;
      if (line.isUser) {
        kept.push(line.text);
        keptUser = true;
      }
      continue;
    }
    kept.push(line.text);
    used += cost;
    if (line.isUser) keptUser = true;
  }
  return kept.reverse();
}
