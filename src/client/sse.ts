import { state, markSessionEnded } from "./state";
import {
  renderComments,
  applyHighlights,
  applyRoundState,
  updateNav,
  positionCards,
} from "./render";

let sseHasConnectedOnce = false;
let currentEs: EventSource | null = null;
let lastEventAt = Date.now();
// Consecutive failed connection attempts with no successful open in between.
// A transient blip resolves on the next reconnect (resetting this to 0); a
// dead server never reconnects, so a sustained run means the server is gone.
let consecutiveSseErrors = 0;
const MAX_SSE_ERRORS = 4;

export async function softRefresh({ rehighlight = false } = {}): Promise<void> {
  try {
    const res = await fetch("/api/comments");
    const data = await res.json();
    if (typeof data.totalRounds === "number" && data.totalRounds > state.totalRounds) {
      window.location.reload();
      return;
    }
    state.comments = data.comments;
    state.roundResolved = data.roundResolved;
    renderComments();
    if (rehighlight) applyHighlights();
    positionCards();
    updateNav();
    applyRoundState();
  } catch {
    /* non-fatal */
  }
}

export function forceReconnect(reason: string): void {
  try {
    console.warn("[redline] forcing SSE reconnect:", reason);
  } catch {}
  if (currentEs) {
    try {
      currentEs.close();
    } catch {}
    currentEs = null;
  }
}

function onVisibleOrFocus(): void {
  if (document.visibilityState === "visible") {
    softRefresh({ rehighlight: true });
  }
}

export function initSSE(): void {
  document.addEventListener("visibilitychange", onVisibleOrFocus);
  window.addEventListener("focus", onVisibleOrFocus);

  // Tell the server explicitly when this tab is going away, so it can
  // distinguish a real close from a bare SSE drop (sleep, network blip) and
  // not abandon a session the user means to keep. `keepalive` lets the POST
  // survive unload; `pagehide` is more reliable than `beforeunload`. Skip the
  // bfcache case (e.persisted) — the page may be restored and reconnect.
  window.addEventListener("pagehide", (e) => {
    if ((e as PageTransitionEvent).persisted) return;
    try {
      fetch("/api/tab-closed", {
        method: "POST",
        keepalive: true,
        headers: { "X-Redline-Token": state.csrfToken },
      });
    } catch {
      /* unload is best-effort */
    }
  });

  setInterval(() => {
    const banner = document.getElementById("sidebar-status-banner");
    const revising = banner?.classList.contains("revising");
    if (!revising) return;
    const silenceMs = Date.now() - lastEventAt;
    if (silenceMs > 30_000) {
      forceReconnect(`no events for ${Math.round(silenceMs / 1000)}s during revision`);
    }
  }, 5000);

  (function connectEvents() {
    const es = new EventSource("/api/events?client=browser");
    currentEs = es;
    lastEventAt = Date.now();
    const on = (name: string, fn: (e: MessageEvent) => void) =>
      es.addEventListener(name, (e) => {
        lastEventAt = Date.now();
        fn(e as MessageEvent);
      });
    es.onopen = () => {
      lastEventAt = Date.now();
      consecutiveSseErrors = 0;
      if (sseHasConnectedOnce) {
        softRefresh({ rehighlight: true });
      }
      sseHasConnectedOnce = true;
    };
    on("comment-thinking", (e) => {
      try {
        state.thinkingCommentIds.add(JSON.parse(e.data).commentId);
      } catch {}
      renderComments();
      positionCards();
      updateNav();
    });
    on("agent-replied", () => {
      state.thinkingCommentIds.clear();
      softRefresh();
    });
    on("comment-added", () => softRefresh({ rehighlight: true }));
    on("comment-reply", (e) => {
      try {
        state.thinkingCommentIds.delete(JSON.parse(e.data).commentId);
      } catch {}
      softRefresh();
    });
    on("comment-resolved", () => softRefresh({ rehighlight: true }));
    on("reload", () => {
      sessionStorage.setItem("just-revised", "1");
      window.location.reload();
    });
    on("revision-chunk", (e) => {
      try {
        const { text, kind } = JSON.parse(e.data);
        const stream = document.getElementById("revision-stream");
        if (stream) {
          if (stream.style.display === "none" || !stream.style.display) stream.style.display = "block";
          const span = document.createElement("span");
          span.className = kind === "thinking" ? "rs-thinking" : "rs-text";
          span.textContent = text;
          stream.appendChild(span);
          stream.scrollTop = stream.scrollHeight;
        }
      } catch {}
    });
    on("revision-error", (e) => {
      let msg = "Revision failed.";
      try {
        msg = "Revision failed: " + (JSON.parse(e.data).message ?? "unknown error");
      } catch {}
      softRefresh();
      const banner = document.getElementById("sidebar-status-banner");
      if (banner) {
        banner.classList.remove("revising");
        banner.classList.remove("error");
        banner.classList.add("error");
        banner.textContent = msg + ' Click "Revise document" to retry.';
        banner.style.display = "block";
      }
    });
    on("revision-stalled", (e) => {
      let msg = "Revision did not complete.";
      try {
        msg = "Revision did not complete: " + (JSON.parse(e.data).message ?? "unknown");
      } catch {}
      softRefresh();
      const banner = document.getElementById("sidebar-status-banner");
      if (banner) {
        banner.classList.remove("revising");
        banner.classList.remove("error");
        banner.classList.add("error");
        banner.textContent = msg + ' Click "Revise document" to retry.';
        banner.style.display = "block";
      }
    });
    on("revision-no-changes", () => {
      try {
        sessionStorage.setItem("rl-no-changes", "1");
      } catch {}
      window.location.reload();
    });
    on("agent-unavailable", (e) => {
      let reason = "Agent process unavailable. Restart redline to recover.";
      try {
        const data = JSON.parse(e.data);
        if (data.reason) reason = data.reason;
      } catch {}
      const el = document.getElementById("agent-status");
      if (el) {
        el.textContent = "Agent offline";
        el.setAttribute("title", reason);
        el.removeAttribute("hidden");
      }
    });
    on("finished", () => {
      document.body.innerHTML =
        '<div style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:system-ui;flex-direction:column;gap:16px;color:#374151"><div style="font-size:48px">\u2713</div><div style="font-size:20px;font-weight:600">Review complete</div><div style="color:#6b7280">You can close this tab and continue in your agent environment.</div></div>';
    });
    es.onerror = () => {
      es.close();
      if (currentEs === es) currentEs = null;
      consecutiveSseErrors += 1;
      // A run of failures with no successful open in between means the server
      // is gone for good (it exited, or restarted on a fresh port this tab
      // can't reach). Stop the silent retry loop and tell the user.
      if (consecutiveSseErrors >= MAX_SSE_ERRORS) {
        markSessionEnded();
        return;
      }
      setTimeout(connectEvents, 3000);
    };
  })();
}
