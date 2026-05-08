// Test fixture: append N comments to the sidecar at the given path. Each
// comment is tagged with the prefix so the parent test can verify both
// writers' rows landed without trampling each other.
//
// Used by sidecar.test.ts to prove the file lock prevents concurrent
// redline processes from clobbering each other's writes.
//
// Usage: bun run sidecar-writer.ts <docPath> <prefix> <count>

import { withSidecar, getOrCreateActiveRound } from "../../src/sidecar";

const docPath = process.argv[2]!;
const prefix = process.argv[3]!;
const count = parseInt(process.argv[4]!, 10);

if (!docPath || !prefix || !Number.isFinite(count)) {
  console.error("Usage: sidecar-writer.ts <docPath> <prefix> <count>");
  process.exit(2);
}

(async () => {
  for (let i = 0; i < count; i++) {
    await withSidecar(docPath, (sidecar) => {
      const round = getOrCreateActiveRound(sidecar);
      round.comments.push({
        id: `${prefix}-${i}`,
        quote: "x",
        context_before: "",
        context_after: "",
        thread: [],
        resolved: false,
      });
    });
  }
  console.log(`${prefix} done`);
})();
