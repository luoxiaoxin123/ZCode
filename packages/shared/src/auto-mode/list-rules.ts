/**
 * auto 模式黑白名单规则字符串解析：`Tool` 或 `Tool(content)`。
 * GUI 用它做输入校验，Agent 用它做匹配前的解析，两端语义一致。
 */
export interface AutoModeListRule {
  toolName: string;
  ruleContent?: string;
}

const RULE_PATTERN = /^([A-Za-z_][\w.:-]*)(?:\((.*)\))?$/su;

export function parseAutoModeListRule(raw: string): AutoModeListRule | null {
  const match = RULE_PATTERN.exec(raw.trim());
  if (!match) return null;
  const toolName = match[1]!;
  const content = match[2]?.trim();
  if (match[2] !== undefined && !content) return null;
  return content ? { toolName, ruleContent: content } : { toolName };
}

export function formatAutoModeListRule(rule: AutoModeListRule): string {
  return rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName;
}
