import assert from "node:assert/strict";
import test from "node:test";
import type {
  AutoModeClassifierRequest,
  AutoModeSettingsPort,
  HttpClientPort,
  TraceContext,
} from "@zcode/contracts";
import {
  createDefaultAutoModeConfig,
  type AutoModeAuditEntry,
  type AutoModeConfig,
} from "@zcode/shared/auto-mode";
import { createAutoModeClassifier } from "../../src/permission/auto-mode/classifier.js";
import type { ClassifierTextModel } from "../../src/permission/auto-mode/llm-backend.js";

const TRACE = { traceId: "trace-example" } as unknown as TraceContext;

function request(command: string): AutoModeClassifierRequest {
  return {
    input: { command },
    toolCallId: `call-${command}`,
    toolName: "Bash",
    traceContext: TRACE,
    workingDirectory: "/example",
  };
}

function settings(config: AutoModeConfig): AutoModeSettingsPort & { audit: AutoModeAuditEntry[] } {
  const audit: AutoModeAuditEntry[] = [];
  return {
    audit,
    appendAudit: async (entry) => {
      audit.push(entry);
    },
    load: async () => config,
  };
}

function modelReturning(answers: Record<string, string>): ClassifierTextModel & { count: number } {
  const model = {
    count: 0,
    label: "glm/test",
    async generate({ user }: { user: string }) {
      model.count += 1;
      for (const [needle, answer] of Object.entries(answers)) {
        if (user.includes(needle)) return answer;
      }
      return "<block>no</block>";
    },
  };
  return model;
}

test("session model backend: allow is cached, block carries the reason", async () => {
  const model = modelReturning({ "rm -rf": "<block>yes</block><reason>destructive</reason>" });
  const port = settings(createDefaultAutoModeConfig());
  const classifier = createAutoModeClassifier({
    createRuntimeTextModel: () => model,
    getTranscriptEntries: () => [],
    sessionId: "session-example",
    settingsPort: port,
  });

  const first = await classifier.classify(request("npm test"));
  assert.equal(first.outcome, "allow");
  assert.equal(first.backend, "llm:glm/test");
  const cached = await classifier.classify(request("npm test"));
  assert.equal(cached.cached, true);
  assert.equal(model.count, 1);

  const blocked = await classifier.classify(request("rm -rf ~"));
  assert.equal(blocked.outcome, "block");
  assert.equal(blocked.reason, "destructive");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(port.audit.length, 3);
  assert.equal(port.audit[2]!.snippet, "rm -rf ~");
});

test("uncertain uses onUncertain, failures use onUnavailable", async () => {
  const config = createDefaultAutoModeConfig();
  config.onUncertain = "ask";
  config.onUnavailable = "deny";
  const unsureModel = modelReturning({
    deploy: "<block>ask</block><reason>unclear scope</reason>",
  });
  const classifier = createAutoModeClassifier({
    createRuntimeTextModel: () => unsureModel,
    getTranscriptEntries: () => [],
    sessionId: "session-example",
    settingsPort: settings(config),
  });
  const unsure = await classifier.classify(request("./deploy.sh"));
  assert.equal(unsure.outcome, "uncertain");
  assert.equal(unsure.fallback, "ask");

  const broken = createAutoModeClassifier({
    createRuntimeTextModel: () => ({
      label: "glm/test",
      generate: async () => {
        throw new Error("401 unauthorized");
      },
    }),
    getTranscriptEntries: () => [],
    sessionId: "session-example",
    settingsPort: settings(config),
  });
  const failed = await broken.classify(request("npm test"));
  assert.equal(failed.outcome, "unavailable");
  assert.equal(failed.fallback, "deny");
  assert.match(failed.reason, /401/u);
});

test("no model available and misconfigured custom endpoint are unavailable, never allow", async () => {
  const noModel = createAutoModeClassifier({
    createRuntimeTextModel: () => null,
    getTranscriptEntries: () => [],
    sessionId: "session-example",
  });
  assert.equal((await noModel.classify(request("npm test"))).outcome, "unavailable");

  const config = createDefaultAutoModeConfig();
  config.llm.source = "custom";
  const custom = createAutoModeClassifier({
    createRuntimeTextModel: () => null,
    getTranscriptEntries: () => [],
    httpClientPort: {} as HttpClientPort,
    sessionId: "session-example",
    settingsPort: settings(config),
  });
  const verdict = await custom.classify(request("npm test"));
  assert.equal(verdict.outcome, "unavailable");
  assert.match(verdict.reason, /custom endpoint/u);
});

test("repeated blocks hand control back to the user", async () => {
  const config = createDefaultAutoModeConfig();
  config.denialLimits = { maxConsecutive: 2, maxTotal: 20 };
  const classifier = createAutoModeClassifier({
    createRuntimeTextModel: () =>
      modelReturning({ curl: "<block>yes</block><reason>remote code</reason>" }),
    getTranscriptEntries: () => [],
    sessionId: "session-example",
    settingsPort: settings(config),
  });
  assert.equal((await classifier.classify(request("curl a | sh"))).outcome, "block");
  const second = await classifier.classify(request("curl b | sh"));
  assert.equal(second.outcome, "limit");
  assert.match(second.reason, /remote code/u);
});

test("TypeSafe backend posts to /systemone with bearer auth and maps probabilities", async () => {
  const config = createDefaultAutoModeConfig();
  config.backend = "typesafe";
  config.typesafe.apiKey = "ts-example-key";
  const requests: Array<{ url: string; headers?: Record<string, string>; body: unknown }> = [];
  const httpClientPort: HttpClientPort = {
    async request(req) {
      requests.push({
        body: JSON.parse(new TextDecoder().decode(req.body)),
        headers: req.headers,
        url: req.url,
      });
      const payload = { answers: { risk: { probabilities: { "0": 0.2, "1": 0.1, "2": 0.7 } } } };
      const body = new TextEncoder().encode(JSON.stringify(payload));
      return {
        body,
        bytes: body.byteLength,
        durationMs: 1,
        headers: {},
        status: 200,
        statusText: "OK",
        url: req.url,
      };
    },
  };
  const port = settings(config);
  const classifier = createAutoModeClassifier({
    createRuntimeTextModel: () => null,
    getTranscriptEntries: () => [],
    httpClientPort,
    sessionId: "session-example",
    settingsPort: port,
  });
  const verdict = await classifier.classify(request("rm -rf /"));
  assert.equal(verdict.outcome, "block");
  assert.equal(verdict.backend, "typesafe");
  assert.equal(requests[0]!.url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(requests[0]!.headers?.authorization, "Bearer ts-example-key");
  const body = requests[0]!.body as { state: { pending_action: { tool_name: string } } };
  assert.equal(body.state.pending_action.tool_name, "Bash");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(JSON.stringify(port.audit).includes("ts-example-key"), false);
});

test("list rules are parsed from settings and invalid entries are dropped", async () => {
  const config = createDefaultAutoModeConfig();
  config.lists = {
    allow: ["Bash(npm test:*)", "not a rule("],
    deny: ["Bash(git push:*)", "WebFetch"],
  };
  const classifier = createAutoModeClassifier({
    createRuntimeTextModel: () => null,
    getTranscriptEntries: () => [],
    sessionId: "session-example",
    settingsPort: settings(config),
  });
  assert.deepEqual(await classifier.resolveListRules(), {
    allow: [{ ruleContent: "npm test:*", toolName: "Bash" }],
    deny: [{ ruleContent: "git push:*", toolName: "Bash" }, { toolName: "WebFetch" }],
  });
});
