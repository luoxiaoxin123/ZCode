import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDefaultAutoModeConfig } from "@zcode/shared";
import { setDataBaseDir } from "../src/paths.js";
import {
  createAutoModeService,
  hasGatekeeperHook,
  maskApiKey,
  mergeAutoModeConfigUpdate,
  parseAuditLines,
} from "../src/auto-mode/autoModeService.js";

test("api keys are masked in the view and kept unless explicitly replaced", () => {
  assert.deepEqual(maskApiKey(""), { configured: false });
  assert.deepEqual(maskApiKey("sk-example-1234"), { configured: true, masked: "••••1234" });

  const current = createDefaultAutoModeConfig();
  current.typesafe.apiKey = "ts-old-key";
  current.llm.custom = {
    apiKey: "custom-old-key",
    baseURL: "https://example.com/v1",
    model: "m",
    protocol: "openai-compatible",
    thinkingParam: "none",
  };
  const fromUi = structuredClone(current);
  fromUi.typesafe.apiKey = "";
  fromUi.llm.custom!.apiKey = "";
  fromUi.llm.thinking = true;

  const kept = mergeAutoModeConfigUpdate(current, { config: fromUi });
  assert.equal(kept.typesafe.apiKey, "ts-old-key");
  assert.equal(kept.llm.custom?.apiKey, "custom-old-key");
  assert.equal(kept.llm.thinking, true);

  const replaced = mergeAutoModeConfigUpdate(current, {
    config: fromUi,
    replaceApiKeys: { typesafe: "ts-new-key" },
  });
  assert.equal(replaced.typesafe.apiKey, "ts-new-key");
  assert.equal(replaced.llm.custom?.apiKey, "custom-old-key");
});

test("audit parsing returns newest first and skips broken lines", () => {
  const line = (toolName: string) =>
    JSON.stringify({
      backend: "llm:glm/test",
      latencyMs: 10,
      outcome: "allow",
      reason: "ok",
      sessionId: "s",
      snippet: "npm test",
      toolName,
      ts: "2026-09-21T00:00:00.000Z",
    });
  const text = [line("First"), "{broken", line("Second"), ""].join("\n");
  const entries = parseAuditLines(text, 10);
  assert.deepEqual(
    entries.map((entry) => entry.toolName),
    ["Second", "First"],
  );
});

test("gatekeeper hook detection matches process hooks on any event", () => {
  const withGatekeeper = {
    hooks: {
      events: {
        PreToolUse: [
          {
            args: ["C:\\Users\\example\\.zcode\\gatekeeper\\gatekeeper.mjs", "review"],
            command: "node",
            type: "process",
          },
        ],
      },
    },
  };
  assert.equal(hasGatekeeperHook(withGatekeeper), true);
  assert.equal(
    hasGatekeeperHook({ hooks: { events: { PreToolUse: [{ command: "echo hi" }] } } }),
    false,
  );
  assert.equal(hasGatekeeperHook(null), false);
});

test("service round-trips config through the data dir without leaking keys", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-auto-mode-"));
  setDataBaseDir(dir);
  try {
    const service = createAutoModeService();
    const initial = await service.getConfig();
    assert.equal(initial.config.backend, "llm");
    assert.equal(initial.apiKeys.typesafe.configured, false);

    const next = structuredClone(initial.config);
    next.backend = "typesafe";
    next.lists.deny = ["Bash(git push:*)"];
    const saved = await service.updateConfig({
      config: next,
      replaceApiKeys: { typesafe: "ts-example-secret" },
    });
    assert.equal(saved.config.typesafe.apiKey, "");
    assert.equal(saved.apiKeys.typesafe.configured, true);

    const onDisk = JSON.parse(await readFile(saved.configFilePath, "utf-8"));
    assert.equal(onDisk.typesafe.apiKey, "ts-example-secret");
    assert.deepEqual(onDisk.lists.deny, ["Bash(git push:*)"]);

    await mkdir(join(dir, ".zcode", "cli"), { recursive: true });
    await writeFile(
      join(dir, ".zcode", "cli", "config.json"),
      JSON.stringify({
        hooks: { events: { PermissionRequest: [{ args: ["/x/gatekeeper/gatekeeper.mjs"] }] } },
      }),
    );
    assert.equal((await service.detectGatekeeperHooks()).detected, true);
    assert.deepEqual(await service.listRecentDecisions(), []);
  } finally {
    setDataBaseDir(null);
    await rm(dir, { force: true, recursive: true });
  }
});
