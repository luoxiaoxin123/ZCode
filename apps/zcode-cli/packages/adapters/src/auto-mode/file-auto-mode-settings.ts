// ============================================================
// Auto 模式配置与审计的文件 adapter
// ============================================================
//
// 配置：`<dataBase>/.zcode/v2/auto-mode.json`，由桌面 Host 写入；这里只读，按 mtime 热加载，
// 改完设置不用重启会话。Host spawn Agent 时通过 ZCODE_AUTO_MODE_CONFIG_FILE 下发绝对路径。
// 审计：同目录 `auto-mode-audit.jsonl`，追加写入，超过上限轮转为 `.1`。
// spec：docs/specs/auto-mode.md。

import { appendFile, mkdir, readFile, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AutoModeSettingsPort } from "@zcode/contracts";
import {
  AUTO_MODE_AUDIT_FILE_NAME,
  AUTO_MODE_CONFIG_FILE_NAME,
  ZCODE_AUTO_MODE_CONFIG_FILE_ENV,
  createDefaultAutoModeConfig,
  parseAutoModeConfig,
  type AutoModeAuditEntry,
  type AutoModeConfig,
} from "@zcode/shared/auto-mode";

const ZCODE_DATA_BASE_DIR_ENV = "ZCODE_DATA_BASE_DIR";
const AUDIT_MAX_BYTES = 5 * 1024 * 1024;
const ROTATED_SUFFIX = ".1";

export interface FileAutoModeSettingsOptions {
  env?: Record<string, string | undefined>;
  /** 显式配置文件路径（测试用）；优先于 env。 */
  configFilePath?: string;
  onConfigError?: (message: string) => void;
}

export function resolveAutoModeConfigFilePath(
  env: Record<string, string | undefined> = process.env,
): string {
  const explicit = env[ZCODE_AUTO_MODE_CONFIG_FILE_ENV]?.trim();
  if (explicit) return explicit;
  const base = env[ZCODE_DATA_BASE_DIR_ENV]?.trim() || homedir();
  return join(base, ".zcode", "v2", AUTO_MODE_CONFIG_FILE_NAME);
}

export function createFileAutoModeSettingsAdapter(
  options: FileAutoModeSettingsOptions = {},
): AutoModeSettingsPort {
  const configPath = options.configFilePath ?? resolveAutoModeConfigFilePath(options.env);
  const auditPath = join(dirname(configPath), AUTO_MODE_AUDIT_FILE_NAME);
  let cached: { mtimeMs: number; config: AutoModeConfig } | undefined;
  let auditQueue: Promise<void> = Promise.resolve();

  return {
    async load() {
      let mtimeMs: number;
      try {
        mtimeMs = (await stat(configPath)).mtimeMs;
      } catch {
        // 文件不存在：使用默认配置（跟随会话模型、默认规则）。
        cached = undefined;
        return createDefaultAutoModeConfig();
      }
      if (cached && cached.mtimeMs === mtimeMs) return cached.config;
      let raw: unknown;
      try {
        raw = JSON.parse(await readFile(configPath, "utf8"));
      } catch (error) {
        options.onConfigError?.(
          `auto-mode.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
        return cached?.config ?? createDefaultAutoModeConfig();
      }
      const parsed = parseAutoModeConfig(raw);
      if (parsed.error) options.onConfigError?.(`auto-mode.json is invalid: ${parsed.error}`);
      cached = { config: parsed.config, mtimeMs };
      return parsed.config;
    },

    appendAudit(entry: AutoModeAuditEntry) {
      // 串行写入，避免并发工具调用交错写同一行。
      auditQueue = auditQueue.then(() => appendAuditLine(auditPath, entry)).catch(() => {});
      return auditQueue;
    },
  };
}

async function appendAuditLine(auditPath: string, entry: AutoModeAuditEntry): Promise<void> {
  await mkdir(dirname(auditPath), { recursive: true });
  try {
    const size = (await stat(auditPath)).size;
    if (size > AUDIT_MAX_BYTES) await rename(auditPath, `${auditPath}${ROTATED_SUFFIX}`);
  } catch {
    // 文件不存在时直接创建。
  }
  await appendFile(auditPath, `${JSON.stringify(entry)}\n`, "utf8");
}
