import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { spawnSync } from "child_process";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const SCRIPT = path.join(REPO_ROOT, "scripts/install-skill.sh");

function runInstall(claudeHome: string) {
  return spawnSync("bash", [SCRIPT], {
    env: { ...process.env, CLAUDE_HOME: claudeHome },
    encoding: "utf-8",
  });
}

test("install-skill.sh substitutes the redline binary path into the installed SKILL.md", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "redline-skill-install-"));
  const result = runInstall(tmp);

  expect(result.status).toBe(0);

  const installed = path.join(tmp, "skills/redline-review/SKILL.md");
  expect(existsSync(installed)).toBe(true);

  const text = readFileSync(installed, "utf-8");

  // Placeholder must be fully substituted — if any remain, the skill will
  // ship with a literal `__REDLINE_BIN__` and break in any session that runs it.
  expect(text).not.toContain("__REDLINE_BIN__");

  // Substituted path must be absolute and end in `redline`.
  const match = text.match(/(\/\S+\/redline)\b/);
  expect(match).not.toBeNull();
  expect(path.isAbsolute(match![1])).toBe(true);
});

test("install-skill.sh fails if the source SKILL.md has no placeholder", () => {
  // Verifies the safety check that catches a desynced source skill — if a
  // future edit removes `__REDLINE_BIN__`, the installed copy would silently
  // ship with bare `redline`, regressing the PATH-independence guarantee.
  const tmp = mkdtempSync(path.join(tmpdir(), "redline-skill-install-bad-"));
  const fakeRepo = mkdtempSync(path.join(tmpdir(), "redline-fake-repo-"));

  // Stage a fake skill source with no placeholder.
  const fakeSkillDir = path.join(fakeRepo, "skills/redline-review");
  spawnSync("mkdir", ["-p", fakeSkillDir]);
  spawnSync("cp", [path.join(REPO_ROOT, "skills/redline-review/SKILL.md"), fakeSkillDir]);
  spawnSync("sed", ["-i", "", "s|__REDLINE_BIN__|redline|g", path.join(fakeSkillDir, "SKILL.md")]);

  // Stage the script in the fake repo so REPO_ROOT resolution lands here.
  spawnSync("mkdir", ["-p", path.join(fakeRepo, "scripts")]);
  spawnSync("cp", [SCRIPT, path.join(fakeRepo, "scripts/install-skill.sh")]);

  const result = spawnSync("bash", [path.join(fakeRepo, "scripts/install-skill.sh")], {
    env: { ...process.env, CLAUDE_HOME: tmp },
    encoding: "utf-8",
  });

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("placeholder");
});
