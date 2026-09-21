import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  AUTO_MODE_AUDIT_FILE_NAME,
  AUTO_MODE_CONFIG_FILE_NAME,
  autoModeAuditEntrySchema,
  autoModeConfigSchema,
  parseAutoModeConfig,
  type AutoModeApiKeyState,
  type AutoModeAuditEntry,
  type AutoModeConfig,
  type AutoModeConfigUpdate,
  type AutoModeConfigView,
} from "@zcode/shared";
import { atomicWriteText } from "../fs/atomicFileUtils.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { getAppConfigDir, getZCodeDataRootDir } from "../paths.js";
import type { IAutoModeService } from "./autoMode.js";

const logger = createServiceLogger("autoModeService");

const DEFAULT_RECENT_LIMIT = 20;
const MAX_RECENT_LIMIT = 200;
const MASK_TAIL_CHARS = 4;
const MASK_MIN_LENGTH = 8;
const GATEKEEPER_HOOK_PATTERN = /[\\/]gatekeeper[\\/]gatekeeper\.mjs$/iu;

export function getAutoModeConfigFilePath(): string {
  return join(getAppConfigDir(), AUTO_MODE_CONFIG_FILE_NAME);
}

function getAutoModeAuditFilePath(): string {
  return join(getAppConfigDir(), AUTO_MODE_AUDIT_FILE_NAME);
}

function getCliConfigFilePath(): string {
  return join(getZCodeDataRootDir(), "cli", "config.json");
}

export function maskApiKey(apiKey: string): AutoModeApiKeyState {
  const trimmed = apiKey.trim();
  if (!trimmed) return { configured: false };
  if (trimmed.length < MASK_MIN_LENGTH) return { configured: true, masked: "••••" };
  return { configured: true, masked: `••••${trimmed.slice(-MASK_TAIL_CHARS)}` };
}

async function readConfigFile(filePath: string): Promise<AutoModeConfig> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") {
      logger.warn(undefined, "read auto-mode config failed:", error);
    }
    return parseAutoModeConfig({}).config;
  }
  try {
    const parsed = parseAutoModeConfig(JSON.parse(raw));
    if (parsed.error)
      logger.warn(undefined, "invalid auto-mode config, using defaults:", parsed.error);
    return parsed.config;
  } catch (error) {
    logger.warn(undefined, "auto-mode config is not valid JSON, using defaults:", error);
    return parseAutoModeConfig({}).config;
  }
}

/** 返回给 UI 的视图：明文凭据清空，只保留是否配置与尾号。 */
export function toAutoModeConfigView(config: AutoModeConfig, filePath: string): AutoModeConfigView {
  const customKey = config.llm.custom?.apiKey ?? "";
  return {
    apiKeys: {
      custom: maskApiKey(customKey),
      typesafe: maskApiKey(config.typesafe.apiKey),
    },
    config: {
      ...config,
      llm: {
        ...config.llm,
        ...(config.llm.custom ? { custom: { ...config.llm.custom, apiKey: "" } } : {}),
      },
      typesafe: { ...config.typesafe, apiKey: "" },
    },
    configFilePath: filePath,
  };
}

/** 合并 UI 提交的配置：凭据只在 replaceApiKeys 显式给出时替换。 */
export function mergeAutoModeConfigUpdate(
  current: AutoModeConfig,
  update: AutoModeConfigUpdate,
): AutoModeConfig {
  const next = autoModeConfigSchema.parse(update.config);
  const customKey = update.replaceApiKeys?.custom ?? current.llm.custom?.apiKey ?? "";
  const typesafeKey = update.replaceApiKeys?.typesafe ?? current.typesafe.apiKey;
  return {
    ...next,
    llm: {
      ...next.llm,
      ...(next.llm.custom ? { custom: { ...next.llm.custom, apiKey: customKey } } : {}),
    },
    typesafe: { ...next.typesafe, apiKey: typesafeKey },
  };
}

export function parseAuditLines(text: string, limit: number): AutoModeAuditEntry[] {
  const entries: AutoModeAuditEntry[] = [];
  const lines = text.split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0 && entries.length < limit; index -= 1) {
    const line = lines[index]!.trim();
    if (!line) continue;
    try {
      const parsed = autoModeAuditEntrySchema.safeParse(JSON.parse(line));
      if (parsed.success) entries.push(parsed.data);
    } catch {
      // 截断或损坏的行直接跳过。
    }
  }
  return entries;
}

export function hasGatekeeperHook(cliConfig: unknown): boolean {
  if (!cliConfig || typeof cliConfig !== "object") return false;
  const events = (cliConfig as { hooks?: { events?: unknown } }).hooks?.events;
  if (!events || typeof events !== "object") return false;
  for (const hooks of Object.values(events as Record<string, unknown>)) {
    if (!Array.isArray(hooks)) continue;
    for (const hook of hooks) {
      const args = (hook as { args?: unknown })?.args;
      const command = (hook as { command?: unknown })?.command;
      const candidates = [
        ...(Array.isArray(args) ? args : []),
        ...(typeof command === "string" ? command.split(/\s+/u) : []),
      ];
      if (
        candidates.some(
          (value) =>
            typeof value === "string" && GATEKEEPER_HOOK_PATTERN.test(value.replace(/["']/gu, "")),
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

export function createAutoModeService(): IAutoModeService {
  // 串行化写，避免两个窗口同时保存时互相覆盖一半。
  let writeQueue: Promise<unknown> = Promise.resolve();
  const enqueueWrite = <T>(task: () => Promise<T>): Promise<T> => {
    const queued = writeQueue.then(task, task) as Promise<T>;
    writeQueue = queued.catch(() => {});
    return queued;
  };

  return {
    async getConfig() {
      const filePath = getAutoModeConfigFilePath();
      return toAutoModeConfigView(await readConfigFile(filePath), filePath);
    },

    async updateConfig(update) {
      return enqueueWrite(async () => {
        const filePath = getAutoModeConfigFilePath();
        const merged = mergeAutoModeConfigUpdate(await readConfigFile(filePath), update);
        await mkdir(dirname(filePath), { recursive: true });
        await atomicWriteText(filePath, `${JSON.stringify(merged, null, 2)}\n`);
        logger.info(undefined, "auto-mode config saved", {
          backend: merged.backend,
          llmSource: merged.llm.source,
        });
        return toAutoModeConfigView(merged, filePath);
      });
    },

    async listRecentDecisions(limit = DEFAULT_RECENT_LIMIT) {
      const bounded = Math.max(1, Math.min(MAX_RECENT_LIMIT, Math.floor(limit)));
      try {
        return parseAuditLines(await readFile(getAutoModeAuditFilePath(), "utf-8"), bounded);
      } catch (error) {
        if ((error as { code?: string }).code !== "ENOENT") {
          logger.warn(undefined, "read auto-mode audit failed:", error);
        }
        return [];
      }
    },

    async detectGatekeeperHooks() {
      const configFilePath = getCliConfigFilePath();
      try {
        const cliConfig = JSON.parse(await readFile(configFilePath, "utf-8")) as unknown;
        return { configFilePath, detected: hasGatekeeperHook(cliConfig) };
      } catch {
        return { configFilePath, detected: false };
      }
    },
  } satisfies IAutoModeService;
}
