import { existsSync } from "fs";
import path from "path";
import { createServer } from "./server";
import { resolve } from "./resolve";

const args = process.argv.slice(2);

// redline resolve <file> [--model <id>]
if (args[0] === "resolve") {
  const filePath = args[1];
  if (!filePath) {
    console.error("Usage: redline resolve <file.md> [--model <model-id>]");
    process.exit(1);
  }
  const resolved = path.resolve(filePath);
  if (!existsSync(resolved)) {
    console.error(`File not found: ${resolved}`);
    process.exit(1);
  }
  const modelFlag = args.indexOf("--model");
  const model = modelFlag !== -1 ? args[modelFlag + 1] : undefined;
  resolve(resolved, { model });
} else {
  // redline <file>  — open review reader
  const filePath = args[0];
  if (!filePath) {
    console.error("Usage: redline <file.md>");
    process.exit(1);
  }
  const resolved = path.resolve(filePath);
  if (!existsSync(resolved)) {
    console.error(`File not found: ${resolved}`);
    process.exit(1);
  }

  const app = createServer(resolved);
  const server = Bun.serve({ port: 3000, fetch: app.fetch, idleTimeout: 0 });
  const url = `http://localhost:${server.port}`;
  const bar = "─".repeat(60);
  console.log(`\n${bar}`);
  console.log(`Redline review session`);
  console.log(`  File: ${resolved}`);
  console.log(`  URL:  ${url}    ← open here if you lose the tab`);
  console.log(`${bar}\n`);

  const agentProc = Bun.spawn(
    [process.execPath, "run", path.join(import.meta.dir, "agent.ts"), resolved],
    { stdout: "inherit", stderr: "inherit", stdin: "ignore" }
  );
  process.on("exit", () => agentProc.kill());
  // SIGINT/SIGTERM = abandoned session. Exit 2 so a calling agent can
  // distinguish "user gave up" from "user clicked Done" (exit 0).
  process.on("SIGINT", () => { agentProc.kill(); console.log("\nREDLINE_RESULT: abandoned"); process.exit(2); });
  process.on("SIGTERM", () => { agentProc.kill(); console.log("\nREDLINE_RESULT: abandoned"); process.exit(2); });

  const open =
    process.platform === "darwin" ? "open" :
    process.platform === "win32"  ? "start" : "xdg-open";
  Bun.spawn([open, url]);
}
