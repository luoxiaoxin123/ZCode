import type { AutoModeAuditEntry, AutoModeConfig } from "./config.js";

/** 凭据在 UI 侧只展示是否已配置与打码后的尾号，明文不出 Host。 */
export interface AutoModeApiKeyState {
  configured: boolean;
  masked?: string;
}

export interface AutoModeConfigView {
  /** apiKey 字段已清空；以 apiKeys 判断是否配置。 */
  config: AutoModeConfig;
  apiKeys: {
    custom: AutoModeApiKeyState;
    typesafe: AutoModeApiKeyState;
  };
  configFilePath: string;
}

export interface AutoModeConfigUpdate {
  /** 完整配置；其中的 apiKey 字段会被忽略。 */
  config: AutoModeConfig;
  /** 只有显式给出的凭据才会被替换；空字符串表示清除。 */
  replaceApiKeys?: {
    custom?: string;
    typesafe?: string;
  };
}

export interface AutoModeGatekeeperDetection {
  /** 检测到外置 zcode-gatekeeper hook 仍挂在 ZCode CLI 配置上。 */
  detected: boolean;
  configFilePath: string;
}

export type { AutoModeAuditEntry };
