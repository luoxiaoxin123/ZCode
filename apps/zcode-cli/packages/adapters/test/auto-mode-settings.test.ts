import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createFileAutoModeSettingsAdapter,
  resolveAutoModeConfigFilePath,
} from "../src/auto-mode/file-auto-mode-settings.js";

test("config path: explicit env wins, otherwise <data>/.zcode/v2", () => {
  assert.equal(
    resolveAutoModeConfigFilePath({ ZCODE_AUTO_MODE_CONFIG_FILE: "/x/auto-mode.json" }),
    "/x/auto-mode.json",
  );
  assert.equal(
    resolveAutoModeConfigFilePath({ ZCODE_DATA_BASE_DIR: "/data" }),
    join("/data", ".zcode", "v2", "auto-mode.json"),
  );
});

test("missing file yields defaults; edits are hot-reloaded by mtime; audit appends", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-auto-mode-adapter-"));
  const configFilePath = join(dir, "auto-mode.json");
  const errors: string[] = [];
  const adapter = createFileAutoModeSettingsAdapter({
    configFilePath,
    onConfigError: (message) => errors.push(message),
  });
  try {
    assert.equal((await adapter.load()).llm.thinking, false);

    await writeFile(
      configFilePath,
      JSON.stringify({ llm: { thinking: true }, onUncertain: "deny" }),
    );
    const first = await adapter.load();
    assert.equal(first.llm.thinking, true);
    assert.equal(first.onUncertain, "deny");

    await writeFile(configFilePath, JSON.stringify({ llm: { thinking: false } }));
    const later = new Date(Date.now() + 5_000);
    await utimes(configFilePath, later, later);
    assert.equal((await adapter.load()).llm.thinking, false);

    await writeFile(configFilePath, "{not json");
    const again = new Date(Date.now() + 10_000);
    await utimes(configFilePath, again, again);
    assert.equal((await adapter.load()).llm.thinking, false);
    assert.equal(errors.length, 1);

    await adapter.appendAudit({
      backend: "llm:test",
      latencyMs: 1,
      outcome: "allow",
      reason: "ok",
      sessionId: "s",
      snippet: "npm test",
      toolName: "Bash",
      ts: new Date(0).toISOString(),
    });
    const audit = await readFile(join(dir, "auto-mode-audit.jsonl"), "utf8");
    assert.equal(audit.trim().split("\n").length, 1);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});
