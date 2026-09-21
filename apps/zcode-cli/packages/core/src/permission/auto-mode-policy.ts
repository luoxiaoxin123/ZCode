// ============================================================
// Auto 模式的确定性策略（纯函数，无 I/O）
// ============================================================
//
// 1. 危险 allow 规则过滤：进入 auto 模式后，像 `Bash(python:*)` 这类「任意代码执行」前缀的
//    项目 allow 规则会让审批器形同虚设，因此在 auto 模式下判定时忽略它们。只读过滤、不改磁盘，
//    离开 auto 模式自然恢复。
// 2. 工作区内编辑判定：auto 的快速通道只放行落在工作区内的文件编辑，工作区外的写入交给审批器。
//
// spec：docs/specs/auto-mode.md。

import { isAbsolute, relative, resolve } from "node:path";
import type { PermissionRuleValue, PermissionRuleset } from "@zcode/contracts";

const SHELL_TOOL_NAMES = new Set(["Bash", "Shell", "PowerShell"]);
const AGENT_TOOL_NAMES = new Set(["Agent", "Task"]);
const PATH_INPUT_KEYS = ["file_path", "path", "notebook_path"] as const;

/**
 * 以这些命令开头的 allow 规则等价于「允许执行任意代码」。
 * 覆盖解释器、包运行器、shell、提权以及 Windows 常见的执行入口。
 */
const DANGEROUS_COMMAND_PREFIXES: readonly string[] = [
  "python",
  "python3",
  "python2",
  "py",
  "node",
  "deno",
  "bun",
  "tsx",
  "ts-node",
  "ruby",
  "perl",
  "php",
  "lua",
  "npx",
  "bunx",
  "pnpx",
  "npm run",
  "npm exec",
  "yarn run",
  "yarn dlx",
  "pnpm run",
  "pnpm exec",
  "pnpm dlx",
  "bun run",
  "bash",
  "sh",
  "zsh",
  "fish",
  "ssh",
  "eval",
  "exec",
  "env",
  "xargs",
  "sudo",
  "su",
  "doas",
  "pwsh",
  "powershell",
  "cmd",
  "wsl",
  "iex",
  "invoke-expression",
  "icm",
  "invoke-command",
  "start-process",
  "saps",
  "start",
  "start-job",
  "add-type",
  "new-object",
  "runas",
];

/** 规则内容去掉通配后缀，得到命令前缀（小写、去 .exe）。 */
function normalizeRulePrefix(ruleContent: string): string {
  let content = ruleContent.trim().toLowerCase();
  for (const suffix of [":*", " *", "*"]) {
    if (content.endsWith(suffix)) {
      content = content.slice(0, -suffix.length).trimEnd();
      break;
    }
  }
  const [first = "", ...rest] = content.split(/\s+/u);
  const firstWord = first.endsWith(".exe") ? first.slice(0, -".exe".length) : first;
  return [firstWord, ...rest].join(" ").trim();
}

function isWildcardSuffix(ruleContent: string): boolean {
  const trimmed = ruleContent.trim();
  return trimmed.endsWith("*");
}

export function isDangerousAutoModeAllowRule(rule: PermissionRuleValue): boolean {
  if (AGENT_TOOL_NAMES.has(rule.toolName)) return true;
  if (!SHELL_TOOL_NAMES.has(rule.toolName)) return false;
  const content = rule.ruleContent?.trim();
  // 整个 Bash 工具放行，或 `Bash(*)`。
  if (!content || content === "*") return true;
  const prefix = normalizeRulePrefix(content);
  if (!prefix) return true;
  for (const dangerous of DANGEROUS_COMMAND_PREFIXES) {
    if (prefix === dangerous) return true;
    // `python -c *`、`node -e*` 这类带参数通配同样危险；精确命令（无通配）不算。
    if (prefix.startsWith(`${dangerous} -`) && isWildcardSuffix(content)) return true;
  }
  return false;
}

/** 返回去掉危险 allow 规则后的规则集；deny / ask 规则原样保留。 */
export function filterDangerousAllowRulesForAuto(
  ruleset: PermissionRuleset | null | undefined,
): PermissionRuleset | null | undefined {
  if (!ruleset || !Array.isArray(ruleset.allow)) return ruleset;
  const allow = ruleset.allow.filter((rule) => !isDangerousAutoModeAllowRule(rule));
  return allow.length === ruleset.allow.length ? ruleset : { ...ruleset, allow };
}

/**
 * 编辑类工具的目标路径是否都落在工作区（或当前工作目录）内。
 * 读不到路径时返回 false，交给审批器判断。
 */
export function isEditTargetInsideWorkspace(
  input: unknown,
  roots: { workingDirectory?: string; workspaceRoot?: string },
): boolean {
  if (!input || typeof input !== "object") return false;
  const record = input as Record<string, unknown>;
  const targets = PATH_INPUT_KEYS.map((key) => record[key]).filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  if (targets.length === 0) return false;
  const bases = [roots.workspaceRoot, roots.workingDirectory].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  if (bases.length === 0) return false;
  const cwd = roots.workingDirectory ?? bases[0]!;
  return targets.every((target) => {
    const absolute = resolve(cwd, target);
    return bases.some((base) => isPathInside(base, absolute));
  });
}

function isPathInside(base: string, target: string): boolean {
  const rel = relative(resolve(base), target);
  if (rel === "") return true;
  if (isAbsolute(rel)) return false;
  const [first] = rel.split(/[\\/]/u);
  return first !== "..";
}
