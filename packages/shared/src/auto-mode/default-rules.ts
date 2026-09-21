import type { AutoModeRules } from "./config.js";

/**
 * Auto 模式默认规则。每一段都可以被用户在设置页整段替换（非空即替换）。
 *
 * 分类思路参考 Claude Code auto mode 的公开设计（allow / soft_deny / environment 三段），
 * 文案为 ZCode 自行编写，并补充了 Windows / PowerShell 场景。
 */
export const DEFAULT_AUTO_MODE_RULES: Readonly<AutoModeRules> = Object.freeze({
  allow: [
    "Read-only shell commands and inspection (ls, dir, cat, type, head, tail, wc, pwd, echo, which, where, Get-ChildItem, Get-Content, stat, du, df, ps)",
    "Version and help queries (node --version, python --version, git --version, --help flags)",
    "Read-only git commands (git status, git log, git diff, git show, git branch, git remote -v, git stash list)",
    "Running the project's own tests, linters, formatters, type checkers and builds (npm/pnpm/yarn/bun test|lint|build|typecheck, pytest, cargo test, go test, tsc, eslint, prettier, oxlint)",
    "Installing dependencies declared by the project into the project (npm install, pnpm install, yarn, bun install, pip install -r requirements.txt inside a virtualenv, cargo build)",
    "Creating, editing, moving and deleting individual files inside the current workspace",
    "Running the project's own code with standard toolchains (node, python, go run, cargo run, make) when it is what the user asked for",
    "Local git history operations (git add, git commit, git checkout -b, git switch, git stash, git restore on workspace files)",
    "Building and running project containers with docker / docker compose for local development",
  ],
  soft_deny: [
    "Downloading and executing code from the internet (curl | bash, wget | sh, iwr | iex, Invoke-Expression on downloaded content, npx/pip install from unknown or unverified sources)",
    "Recursive or forced deletion of directories, or deleting anything outside the workspace (rm -rf, Remove-Item -Recurse -Force, rd /s /q, del /s), unless the user explicitly asked for exactly that",
    "Irreversible data loss: dropping databases or tables, truncating files, git reset --hard or git clean -fdx that discards uncommitted user work, overwriting files outside the workspace",
    "Persistence or autostart changes: shell profiles (.bashrc, .zshrc, .profile, $PROFILE), cron, systemd, launchd, Windows Run registry keys, scheduled tasks, startup folders",
    "Privilege escalation (sudo, su, doas, runas, Start-Process -Verb RunAs) unless the user explicitly asked for elevated access",
    "Weakening security: disabling antivirus/AMSI/Defender, changing firewall rules, chmod 777 on sensitive paths, editing hosts files, adding users or SSH keys",
    "Starting servers or listeners reachable from other machines (binding 0.0.0.0, nc -l, exposing ports), except local dev servers the user asked for",
    "Pushing to remotes, force-pushing, deleting remote branches, publishing packages or releases",
    "Reading, printing, copying or uploading secrets, credentials, tokens, SSH keys or browser data, or sending workspace contents to external services the user did not name",
    "Installing or removing system-wide packages or global tools (apt, brew, choco, winget, npm -g, pip install outside a virtualenv)",
    "Writing or modifying files outside the current workspace and standard temp directories without an explicit user request",
  ],
  environment: [
    "The agent is a coding assistant running on the user's own machine inside a project workspace",
    "The user switched to auto mode: routine development work should proceed without interruptions, while risky or irreversible actions still require the user",
    "Common developer toolchains (git, node, python, package managers) are expected to be available",
    "The operating system may be Windows, macOS or Linux; commands may be POSIX shell, cmd or PowerShell",
  ],
});

export type AutoModeRuleSection = keyof AutoModeRules;
export const AUTO_MODE_RULE_SECTIONS: readonly AutoModeRuleSection[] = [
  "allow",
  "soft_deny",
  "environment",
];

/** 生效规则：用户某段非空时整段替换默认。 */
export function resolveEffectiveAutoModeRules(rules: AutoModeRules | undefined): AutoModeRules {
  return {
    allow: rules?.allow.length ? [...rules.allow] : [...DEFAULT_AUTO_MODE_RULES.allow],
    soft_deny: rules?.soft_deny.length
      ? [...rules.soft_deny]
      : [...DEFAULT_AUTO_MODE_RULES.soft_deny],
    environment: rules?.environment.length
      ? [...rules.environment]
      : [...DEFAULT_AUTO_MODE_RULES.environment],
  };
}
