// One-time extraction: pulls the inline <script> body from src/server.ts
// (lines 1604-3031) into src/client/main.js, unescaping the template-literal
// escapes and rerouting the four server-side interpolations through
// window.__REDLINE__. After this runs, server.ts gets the script block
// replaced by a tiny bootstrap + <script src="/client.js">.

const src = await Bun.file("src/server.ts").text();
const lines = src.split("\n");
const scriptLines = lines.slice(1603, 3031); // 1604..3031 inclusive
let body = scriptLines.join("\n");

// Order matters: unescape first, then route real interpolations. The real
// interpolations contain no backslashes so they're untouched by the unescape.
body = body.replace(/\\\$\{/g, "${"); // \${ -> ${
body = body.replace(/\\\\/g, "\\"); // \\ -> \
body = body.replace(/\\`/g, "`"); // \` -> `

body = body.replace(/\$\{commentsJson\}/g, "/** @type {any[]} */ ((window).__REDLINE__.comments)");
body = body.replace(/\$\{roundResolved\}/g, "(window).__REDLINE__.roundResolved");
body = body.replace(/\$\{totalRounds\}/g, "(window).__REDLINE__.totalRounds");
body = body.replace(/\$\{JSON\.stringify\(title\)\}/g, "(window).__REDLINE__.contextTitle");

const out = `// Generated from src/server.ts inline <script> by scripts/extract-client.ts.
// After extraction this file is the source of truth — edit it directly.
// Reads bootstrap state from window.__REDLINE__ injected by pageTemplate().
${body.trimEnd()}\n`;

await Bun.write("src/client/main.js", out);
console.log("wrote src/client/main.js (" + out.length + " chars)");
