import type { ClientComment } from "./lib";

declare global {
  interface Window {
    __REDLINE__: {
      comments: ClientComment[];
      roundResolved: boolean;
      totalRounds: number;
      contextTitle: string;
      csrfToken: string;
      noAgent?: boolean;
    };
    hljs?: { highlightElement(el: HTMLElement): void };
    dismissContextBanner?: () => void;
  }
}

export const state = {
  comments: window.__REDLINE__.comments as ClientComment[],
  roundResolved: window.__REDLINE__.roundResolved,
  totalRounds: window.__REDLINE__.totalRounds,
  csrfToken: window.__REDLINE__.csrfToken || "",
  noAgent: window.__REDLINE__.noAgent === true,
  thinkingCommentIds: new Set<string>(),
  pendingSelection: null as PendingSelection | null,
  navIdx: 0,
  deliberateScrollUntil: 0,
  sessionEnded: false,
};

export type PendingSelection = {
  quote: string;
  context_before: string;
  context_after: string;
  _rectTop?: number;
  _range?: Range;
  _img?: HTMLImageElement;
};

export function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  init = init || {};
  const m = (init.method || "GET").toUpperCase();
  if (m !== "GET" && m !== "HEAD") {
    init.headers = Object.assign({}, init.headers || {}, {
      "X-Redline-Token": state.csrfToken,
    });
  }
  return fetch(url, init);
}

export function showError(msg: string): void {
  const el = document.getElementById("error-banner");
  if (!el) return;
  el.textContent = msg;
  el.style.display = "block";
  setTimeout(() => (el.style.display = "none"), 4000);
}

// The redline server has exited (session ended, or process killed). This tab
// can no longer do anything useful — show a persistent banner instead of
// letting actions fail with a cryptic "Failed to fetch". Idempotent.
export function markSessionEnded(): void {
  if (state.sessionEnded) return;
  state.sessionEnded = true;
  const el = document.getElementById("session-ended-banner");
  if (el) el.style.display = "block";
}

// A fetch network failure (TypeError) on a mutating request means the server
// is unreachable — treat it as a definitively ended session. A non-network
// failure (server replied with an error) is shown as a transient toast.
export function reportMutationFailure(action: string, err: unknown): void {
  if (err instanceof TypeError) {
    markSessionEnded();
  } else {
    showError(action + ": " + (err as Error).message);
  }
}
