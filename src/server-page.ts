function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pageTemplate(
  title: string,
  content: string,
  comments: unknown[],
  roundResolved: boolean,
  agentRepliedAt: string | null,
  roundNumber: number,
  totalRounds: number,
  context?: string,
  readOnly = false,
  csrfToken = "",
  noAgent = false,
  agentName = "selected local"
): string {
  const commentsJson = JSON.stringify(comments);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} — Redline</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.10.0/styles/github.min.css">
  <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.10.0/highlight.min.js"></script>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <div class="layout">
    <div class="reader-col">
      <div class="doc-header">
        <span class="doc-title">
          ${escapeHtml(title)}
          <span style="position:relative">
            <span class="round-badge${totalRounds > 1 ? ' repeat' : ''}${totalRounds > 1 ? ' clickable' : ''}" id="round-badge">Round ${roundNumber} of ${totalRounds}</span>
            ${totalRounds > 1 ? `<div class="round-picker" id="round-picker" style="display:none">${
              Array.from({length: totalRounds}, (_, i) => i + 1).map(n => {
                const isCurrent = n === roundNumber;
                const href = n === totalRounds ? '/' : `/round/${n}`;
                const label = n === totalRounds ? 'Round ' + n + ' — current' : 'Round ' + n;
                return `<a class="round-picker-item${isCurrent ? ' current' : ''}" href="${href}">${label}</a>`;
              }).join('')
            }${!readOnly ? `<button class="round-picker-item round-picker-action" id="btn-compare" type="button">Compare with previous →</button>` : ''}</div>` : ''}
          </span>
        </span>
        <div class="header-actions">
          <span id="agent-status" class="agent-status" hidden></span>
          ${noAgent ? `<span class="manual-mode-pill" title="Started with --no-agent. No ${escapeHtml(agentName)} replies, no revision pass.">Manual mode</span>` : ''}
          ${!readOnly && totalRounds > 1 ? `<button class="btn-toggle-diff" id="btn-toggle-diff" type="button" aria-pressed="false">Show changes</button>` : ''}
          ${readOnly
            ? `<span style="font-size:13px;color:var(--text-muted);font-style:italic">Read-only — <a href="/" style="color:var(--accent)">back to current</a></span>`
            : `<button class="btn-accept" id="btn-accept" disabled>Revise document</button>`
          }
        </div>
      </div>
      ${context ? `<div class="context-banner" id="context-banner">
        <span class="context-text">${escapeHtml(context)}</span>
        <button class="context-dismiss" onclick="dismissContextBanner()" aria-label="Dismiss">✕</button>
      </div>` : ''}
      ${!readOnly ? `<div class="first-run-banner" id="first-run-banner" hidden>
        <span class="first-run-icon" aria-hidden="true">⚠</span>
        <span class="first-run-text">Redline sends document and comment text to your ${escapeHtml(agentName)} agent. Use trusted docs.</span>
        <button class="first-run-dismiss" id="first-run-dismiss" aria-label="Dismiss">Got it</button>
      </div>` : ''}
      <article class="prose" id="prose">
        ${content}
      </article>
    </div>

    <div class="sidebar-col">
      <div id="sidebar-status-banner"></div>
      <div id="comment-nav" style="display:none">
        <span class="nav-count" id="nav-count"></span>
        <button id="nav-prev">↑ Prev</button>
        <button id="nav-next">Next ↓</button>
      </div>
    </div>
  </div>


  <div id="done-banner"></div>
  <div id="diff-overlay">
    <div id="diff-panel">
      <div id="diff-panel-header">
        <h2>Review changes</h2>
        <button class="btn-diff-feedback" id="diff-btn-feedback">Give more feedback</button>
        <button class="btn-diff-accept" id="diff-btn-accept">Looks good — close session</button>
        <button class="btn-diff-close" id="diff-btn-close" aria-label="Close">✕</button>
      </div>
      <div id="diff-panel-body"></div>
    </div>
  </div>
  <div id="error-banner" style="display:none;position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#b71c1c;color:white;padding:12px 24px;border-radius:6px;font-size:14px;font-weight:500;box-shadow:0 1px 4px rgba(0,0,0,0.08);z-index:999;white-space:nowrap;"></div>
  <div id="session-ended-banner" style="display:none;position:fixed;top:0;left:0;right:0;background:#92400e;color:white;padding:10px 24px;font-size:14px;font-weight:500;text-align:center;z-index:1000;box-shadow:0 1px 4px rgba(0,0,0,0.15);">Review session ended — the redline server is no longer running. Your changes up to this point are saved; close this tab and continue in your agent environment.</div>

  <script>
    window.__REDLINE__ = {
      comments: ${commentsJson},
      roundResolved: ${roundResolved},
      totalRounds: ${totalRounds},
      contextTitle: ${JSON.stringify(title)},
      csrfToken: ${JSON.stringify(csrfToken)},
      noAgent: ${JSON.stringify(noAgent)},
    };
  </script>
  <script src="/client.js" defer></script>
</body>
</html>`;
}

export { escapeHtml, pageTemplate };
