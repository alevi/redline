import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { spawnSync } from "child_process";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const SCRIPT = path.join(REPO_ROOT, "scripts/install-skill.sh");
const CLI = path.join(REPO_ROOT, "src/cli.ts");

function runInstall(options: { claudeHome?: string; codexHome?: string; agent?: string; scriptPath?: string; redlineBin?: string }) {
  const args = options.agent ? ["--agent", options.agent] : [];
  return spawnSync("bash", [options.scriptPath ?? SCRIPT, ...args], {
    env: {
      ...process.env,
      ...(options.claudeHome ? { CLAUDE_HOME: options.claudeHome } : {}),
      ...(options.codexHome ? { CODEX_HOME: options.codexHome } : {}),
      ...(options.redlineBin ? { REDLINE_BIN_ABS: options.redlineBin } : {}),
    },
    encoding: "utf-8",
  });
}

test("install-skill.sh substitutes the launcher path into the installed SKILL.md", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "redline-skill-install-"));
  const result = runInstall({ claudeHome: tmp, agent: "claude" });

  expect(result.status).toBe(0);

  const installed = path.join(tmp, "skills/redline-review/SKILL.md");
  expect(existsSync(installed)).toBe(true);

  const text = readFileSync(installed, "utf-8");
  // No placeholder may remain — a literal `__REDLINE_BIN__` would break every
  // session that runs the skill.
  expect(text).not.toContain("__REDLINE_BIN__");
  expect(text).toContain("const { spawn } = require(\"node:child_process\")");
  expect(text).toContain("detached: true");
  expect(text).toContain("child.unref()");
  expect(text).toContain("[file, \"--open\"]");

  // Substituted path must be the launcher next to SKILL.md, absolute.
  const expectedLauncher = path.join(tmp, "skills/redline-review/redline");
  expect(text).toContain(expectedLauncher);
});

test("install-skill.sh creates an executable launcher that runs bun + cli through absolute paths", () => {
  // The whole point of the launcher: zero $PATH dependency. Verify by stripping
  // PATH entirely from the env when invoking it — a working launcher must still
  // reach bun and cli.ts. (`env -i` would also drop HOME, etc., which the bun
  // runtime needs; clearing PATH alone is the cleanest way to prove the point.)
  const tmp = mkdtempSync(path.join(tmpdir(), "redline-skill-launch-"));
  const installResult = runInstall({ claudeHome: tmp, agent: "claude" });
  expect(installResult.status).toBe(0);

  const launcher = path.join(tmp, "skills/redline-review/redline");
  expect(existsSync(launcher)).toBe(true);
  expect(statSync(launcher).mode & 0o111).toBeGreaterThan(0);

  // Invoke launcher with no args. cli.ts prints `Usage: redline <file.md>` to
  // stderr and exits 1 — that's enough to prove the bun-→-cli chain is wired.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k !== "PATH" && v !== undefined) env[k] = v;
  }
  const run = spawnSync(launcher, [], { env, encoding: "utf-8" });
  expect(run.status).toBe(1);
  expect(run.stderr).toContain("Usage: redline");
});

test("install-skill.sh can install into the Codex skills directory", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "redline-codex-skill-"));
  const result = runInstall({ codexHome: tmp, agent: "codex" });

  expect(result.status).toBe(0);

  const installed = path.join(tmp, "skills/redline-review/SKILL.md");
  expect(existsSync(installed)).toBe(true);
  expect(readFileSync(installed, "utf-8")).not.toContain("__REDLINE_BIN__");
});

test("install-skill.sh can install into both supported agent environments", () => {
  const claudeHome = mkdtempSync(path.join(tmpdir(), "redline-both-claude-"));
  const codexHome = mkdtempSync(path.join(tmpdir(), "redline-both-codex-"));
  const result = runInstall({ claudeHome, codexHome });

  expect(result.status).toBe(0);
  expect(existsSync(path.join(claudeHome, "skills/redline-review/SKILL.md"))).toBe(true);
  expect(existsSync(path.join(codexHome, "skills/redline-review/SKILL.md"))).toBe(true);
});

test("install-skill.sh uses packaged redline binary when REDLINE_BIN_ABS is provided", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "redline-packaged-skill-"));
  const fakeBin = path.join(tmp, "redline-bin");
  writeFileSync(fakeBin, "#!/bin/sh\nexit 0\n");
  const result = runInstall({ codexHome: tmp, agent: "codex", redlineBin: fakeBin });

  expect(result.status).toBe(0);
  const launcher = path.join(tmp, "skills/redline-review/redline");
  const launcherText = readFileSync(launcher, "utf-8");
  expect(launcherText).toContain(`exec "${fakeBin}" "$@"`);
  expect(launcherText).not.toContain("src/cli.ts");
});

test("redline install-skill forwards to the installer", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "redline-cli-skill-"));
  const result = spawnSync(process.execPath, ["run", CLI, "install-skill", "--agent", "codex"], {
    env: { ...process.env, CODEX_HOME: tmp },
    encoding: "utf-8",
  });

  expect(result.status).toBe(0);
  expect(existsSync(path.join(tmp, "skills/redline-review/SKILL.md"))).toBe(true);
});

test("install-skill.sh fails if the source SKILL.md has no placeholder", () => {
  // Regression guard: if a future edit removes `__REDLINE_BIN__`, the installed
  // copy would silently ship without the substituted launcher path.
  const tmp = mkdtempSync(path.join(tmpdir(), "redline-skill-install-bad-"));
  const fakeRepo = mkdtempSync(path.join(tmpdir(), "redline-fake-repo-"));

  const fakeSkillDir = path.join(fakeRepo, "skills/redline-review");
  spawnSync("mkdir", ["-p", fakeSkillDir]);
  spawnSync("cp", [path.join(REPO_ROOT, "skills/redline-review/SKILL.md"), fakeSkillDir]);
  const skillFile = path.join(fakeSkillDir, "SKILL.md");
  writeFileSync(skillFile, readFileSync(skillFile, "utf-8").replaceAll("__REDLINE_BIN__", "redline"));

  // Stage src/cli.ts and the script so REPO_ROOT resolution works.
  spawnSync("mkdir", ["-p", path.join(fakeRepo, "src"), path.join(fakeRepo, "scripts")]);
  spawnSync("cp", [path.join(REPO_ROOT, "src/cli.ts"), path.join(fakeRepo, "src/cli.ts")]);
  spawnSync("cp", [SCRIPT, path.join(fakeRepo, "scripts/install-skill.sh")]);

  const result = runInstall({ claudeHome: tmp, agent: "claude", scriptPath: path.join(fakeRepo, "scripts/install-skill.sh") });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("placeholder");
});
