import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import type { PermissionRuleset } from "@zcode/contracts";
import {
  AUTO_MODE_CLASSIFY_RULE_ID,
  AUTO_MODE_FAST_PATH_RULE_ID,
  PermissionService,
  type PermissionContext,
  type PermissionToolCapability,
} from "../../src/permission/service.js";
import {
  filterDangerousAllowRulesForAuto,
  isDangerousAutoModeAllowRule,
  isEditTargetInsideWorkspace,
} from "../../src/permission/auto-mode-policy.js";
import { mergeAutoModeListRules } from "../../src/tool/executor/auto-mode-flow.js";

const WORKSPACE = resolve("/example/workspace");

function ctx(toolName: string, input: unknown): PermissionContext {
  return {
    input,
    mode: "auto",
    riskLevel: "medium",
    toolName,
    workingDirectory: WORKSPACE,
    workspaceRoot: WORKSPACE,
  };
}

const EDIT_CAPABILITY: PermissionToolCapability = {
  permission: {
    permission: "edit",
    sideEffectScope: "workspace",
  } as PermissionToolCapability["permission"],
  readOnly: false,
  sideEffectScope: "workspace",
};
const BASH_CAPABILITY: PermissionToolCapability = {
  destructive: true,
  needsApproval: true,
  readOnly: false,
  riskLevel: "high",
  sideEffectScope: "system",
};

test("auto: read-only tools take the fast path", () => {
  const service = new PermissionService();
  const decision = service.checkPermission(ctx("Read", { file_path: "a.ts" }), {
    readOnly: true,
    sideEffectScope: "none",
  });
  assert.equal(decision.decision, "allow");
  assert.equal(decision.ruleId, AUTO_MODE_FAST_PATH_RULE_ID);
});

test("auto: edits inside the workspace are allowed, outside go to the reviewer", () => {
  const service = new PermissionService();
  const inside = service.checkPermission(ctx("Edit", { file_path: "src/a.ts" }), EDIT_CAPABILITY);
  assert.equal(inside.decision, "allow");
  assert.equal(inside.ruleId, AUTO_MODE_FAST_PATH_RULE_ID);

  const outside = service.checkPermission(
    ctx("Edit", { file_path: resolve("/etc/hosts") }),
    EDIT_CAPABILITY,
  );
  assert.equal(outside.decision, "ask");
  assert.equal(outside.classifierEligible, true);
});

test("auto: risky shell commands are classifier-eligible asks", () => {
  const service = new PermissionService();
  const decision = service.checkPermission(
    ctx("Bash", { command: "rm -rf build" }),
    BASH_CAPABILITY,
  );
  assert.equal(decision.decision, "ask");
  assert.equal(decision.ruleId, AUTO_MODE_CLASSIFY_RULE_ID);
  assert.equal(decision.classifierEligible, true);
});

test("auto: project deny wins, project ask goes to the user (not the reviewer)", () => {
  const service = new PermissionService();
  const rules: PermissionRuleset = {
    ask: [{ ruleContent: "git push:*", toolName: "Bash" }],
    deny: [{ ruleContent: "curl:*", toolName: "Bash" }],
  };
  const denied = service.checkPermission(
    ctx("Bash", { command: "curl https://example.com" }),
    BASH_CAPABILITY,
    rules,
  );
  assert.equal(denied.decision, "deny");

  const asked = service.checkPermission(
    ctx("Bash", { command: "git push origin main" }),
    BASH_CAPABILITY,
    rules,
  );
  assert.equal(asked.decision, "ask");
  assert.notEqual(asked.classifierEligible, true);
});

test("auto: dangerous allow rules are ignored, safe ones still allow", () => {
  const service = new PermissionService();
  const rules: PermissionRuleset = {
    allow: [
      { ruleContent: "python:*", toolName: "Bash" },
      { ruleContent: "git status", toolName: "Bash" },
    ],
  };
  const python = service.checkPermission(
    ctx("Bash", { command: "python evil.py" }),
    BASH_CAPABILITY,
    rules,
  );
  assert.equal(python.decision, "ask");
  assert.equal(python.classifierEligible, true);

  const status = service.checkPermission(
    ctx("Bash", { command: "git status" }),
    BASH_CAPABILITY,
    rules,
  );
  assert.equal(status.decision, "allow");

  // build 模式不受影响：同一条 allow 规则照常生效。
  const build = service.checkPermission(
    { ...ctx("Bash", { command: "python evil.py" }), mode: "build" },
    BASH_CAPABILITY,
    rules,
  );
  assert.equal(build.decision, "allow");
});

test("auto: alwaysAsk tools still require the user", () => {
  const service = new PermissionService();
  const decision = service.checkPermission(ctx("CreateWorkflow", {}), { alwaysAsk: true });
  assert.equal(decision.decision, "ask");
  assert.notEqual(decision.classifierEligible, true);
});

test("auto: GUI deny list overrides the fast path", () => {
  const service = new PermissionService();
  const merged = mergeAutoModeListRules(null, {
    allow: [],
    deny: [{ ruleContent: "secrets/*", toolName: "Edit" }],
  });
  const decision = service.checkPermission(
    ctx("Edit", { file_path: "secrets/key.pem" }),
    EDIT_CAPABILITY,
    merged,
  );
  assert.equal(decision.decision, "deny");
});

test("dangerous allow rule detection", () => {
  const cases: Array<[string, string | undefined, boolean]> = [
    ["Bash", undefined, true],
    ["Bash", "*", true],
    ["Bash", "python:*", true],
    ["Bash", "node -e *", true],
    ["Bash", "npm run:*", true],
    ["PowerShell", "powershell.exe:*", true],
    ["Bash", "npm test:*", false],
    ["Bash", "git status", false],
    ["Bash", "node --version", false],
    ["Agent", undefined, true],
    ["Read", undefined, false],
  ];
  for (const [toolName, ruleContent, expected] of cases) {
    assert.equal(
      isDangerousAutoModeAllowRule(ruleContent ? { ruleContent, toolName } : { toolName }),
      expected,
      `${toolName}(${ruleContent ?? ""})`,
    );
  }
  const filtered = filterDangerousAllowRulesForAuto({
    allow: [{ toolName: "Bash" }, { ruleContent: "npm test:*", toolName: "Bash" }],
    deny: [{ toolName: "Bash" }],
  });
  assert.deepEqual(filtered?.allow, [{ ruleContent: "npm test:*", toolName: "Bash" }]);
  assert.deepEqual(filtered?.deny, [{ toolName: "Bash" }]);
});

test("edit target workspace check handles relative, absolute and traversal paths", () => {
  const roots = { workingDirectory: WORKSPACE, workspaceRoot: WORKSPACE };
  assert.equal(isEditTargetInsideWorkspace({ file_path: "src/a.ts" }, roots), true);
  assert.equal(isEditTargetInsideWorkspace({ file_path: resolve(WORKSPACE, "b.ts") }, roots), true);
  assert.equal(isEditTargetInsideWorkspace({ file_path: "../outside.ts" }, roots), false);
  assert.equal(isEditTargetInsideWorkspace({ file_path: resolve("/tmp/x") }, roots), false);
  assert.equal(isEditTargetInsideWorkspace({}, roots), false);
});
