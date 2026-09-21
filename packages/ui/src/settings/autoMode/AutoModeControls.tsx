import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input.js";
import { Textarea } from "@/components/ui/textarea.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";

export interface AutoModeOption<T extends string> {
  value: T;
  label: string;
}

export function AutoModeSelect<T extends string>({
  value,
  options,
  onValueChange,
  disabled,
  ariaLabel,
}: {
  value: T;
  options: readonly AutoModeOption<T>[];
  onValueChange: (value: T) => void;
  disabled?: boolean;
  ariaLabel: string;
}) {
  return (
    <Select value={value} disabled={disabled} onValueChange={(next) => onValueChange(next as T)}>
      <SelectTrigger size="lg" aria-label={ariaLabel} className="w-full min-w-0 justify-between">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** 失焦或回车时提交的输入框；外部值变化时同步。 */
export function AutoModeCommitInput({
  value,
  onCommit,
  placeholder,
  type = "text",
  ariaLabel,
  disabled,
}: {
  value: string;
  onCommit: (value: string) => void;
  placeholder?: string;
  type?: "text" | "password" | "number" | "url";
  ariaLabel: string;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  return (
    <Input
      aria-label={ariaLabel}
      className="w-full"
      disabled={disabled}
      placeholder={placeholder}
      type={type}
      value={draft}
      onBlur={commit}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
      }}
    />
  );
}

/**
 * 一行一条的列表编辑器：失焦时校验并提交；存在非法行时不提交并提示。
 */
export function AutoModeLineListEditor({
  value,
  onCommit,
  placeholder,
  ariaLabel,
  validateLine,
  invalidMessage,
  disabled,
}: {
  value: readonly string[];
  onCommit: (lines: string[]) => void;
  placeholder?: string;
  ariaLabel: string;
  validateLine?: (line: string) => boolean;
  invalidMessage?: (lines: string[]) => string;
  disabled?: boolean;
}) {
  const joined = value.join("\n");
  const [draft, setDraft] = useState(joined);
  const [invalid, setInvalid] = useState<string[]>([]);
  useEffect(() => {
    setDraft(joined);
    setInvalid([]);
  }, [joined]);

  const commit = () => {
    const lines = draft
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const badLines = validateLine ? lines.filter((line) => !validateLine(line)) : [];
    setInvalid(badLines);
    if (badLines.length > 0) return;
    if (lines.join("\n") !== joined) onCommit(lines);
  };

  return (
    <div className="space-y-1.5">
      <Textarea
        aria-invalid={invalid.length > 0}
        aria-label={ariaLabel}
        className="min-h-24 font-mono"
        disabled={disabled}
        placeholder={placeholder}
        spellCheck={false}
        value={draft}
        onBlur={commit}
        onChange={(event) => setDraft(event.target.value)}
      />
      {invalid.length > 0 && invalidMessage ? (
        <div className="text-ui-sm text-destructive">{invalidMessage(invalid)}</div>
      ) : null}
    </div>
  );
}
