// 审批器外部 HTTP 调用：统一走 HttpClientPort（代理、证书、超时、trace 由 adapter 处理）。
import { isHttpClientPortError, type HttpClientPort, type TraceContext } from "@zcode/contracts";

const RETRYABLE_STATUS = new Set([429, 503, 529]);
const RETRY_BASE_DELAY_MS = 400;
const MAX_ATTEMPTS = 2;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_BODY_CHARS = 200;

export class AutoModeHttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "AutoModeHttpError";
  }
}

export async function postJsonWithRetry(input: {
  httpClientPort: HttpClientPort;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  timeoutMs: number;
  traceContext: TraceContext;
  signal?: AbortSignal;
}): Promise<unknown> {
  const encoded = new TextEncoder().encode(JSON.stringify(input.body));
  let lastError: AutoModeHttpError | undefined;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      if (!lastError?.status || !RETRYABLE_STATUS.has(lastError.status)) break;
      await delay(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), input.signal);
    }
    try {
      const response = await input.httpClientPort.request(
        {
          body: encoded,
          headers: { "content-type": "application/json", ...input.headers },
          maxResponseBytes: MAX_RESPONSE_BYTES,
          method: "POST",
          timeoutMs: input.timeoutMs,
          trace: input.traceContext,
          url: input.url,
        },
        input.signal ? { signal: input.signal } : {},
      );
      const text = new TextDecoder().decode(response.body);
      if (response.status < 200 || response.status >= 300) {
        lastError = new AutoModeHttpError(
          `HTTP ${response.status} ${response.statusText}: ${text.slice(0, MAX_ERROR_BODY_CHARS)}`.trim(),
          response.status,
        );
        continue;
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new AutoModeHttpError(
          `Invalid JSON response: ${text.slice(0, MAX_ERROR_BODY_CHARS)}`,
        );
      }
    } catch (error) {
      if (error instanceof AutoModeHttpError) throw error;
      const message = isHttpClientPortError(error)
        ? `${error.code}: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
      throw new AutoModeHttpError(message);
    }
  }
  throw lastError ?? new AutoModeHttpError("Request failed");
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AutoModeHttpError("cancelled"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AutoModeHttpError("cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function joinUrl(base: string, path: string): string {
  return `${base.trim().replace(/\/+$/u, "")}${path}`;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** extraBody 深合并：对象递归合并，其它类型直接覆盖。 */
export function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(source)) {
    const existing = result[key];
    result[key] =
      isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value;
  }
  return result;
}
