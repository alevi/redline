// Generated from src/server.ts inline <script> by scripts/extract-client.ts.
// After extraction this file is the source of truth — edit it directly.
// Reads bootstrap state from window.__REDLINE__ injected by pageTemplate().
import {
  escapeHtml,
  latestVerdict,
  nearestCell,
  clampRangeToCell,
  captureSelection as _captureSelection,
  highlightText as _highlightText,
  computeNavState,
  preserveScroll as _preserveScroll,
} from "./lib";

    // ── State ────────────────────────────────────────────────────────
    let comments = /** @type {any[]} */ ((window).__REDLINE__.comments);
    let roundResolved = (window).__REDLINE__.roundResolved;
    let totalRounds = (window).__REDLINE__.totalRounds;
    const thinkingCommentIds = new Set();
    let pendingSelection = null;
    let selectionTimer = null;

    // ── Selection → form (debounced so double/triple-click completes first) ──
    document.addEventListener('mouseup', () => {
      if (selectionTimer) { clearTimeout(selectionTimer); selectionTimer = null; }

      selectionTimer = setTimeout(() => {
        selectionTimer = null;
        if (document.getElementById('new-comment-form')) {
          if (window.getSelection()?.toString().trim().length >= 2) nudgeOpenForm();
          return;
        }

        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) return;
        const prose = document.getElementById('prose');
        if (!prose.contains(sel.anchorNode)) return;

        let range = sel.getRangeAt(0);

        // Table cell selections: cross-cell ranges scatter the highlight and break
        // anchoring (the quote text is interleaved with whitespace that doesn't
        // exist in the flat prose text). Instead of rejecting an overshoot, clamp
        // the range to whichever cell anchors the user's intent. The visual
        // selection collapses back to the cell boundary, which is itself the
        // signal that something was corrected — no error wall needed.
        const startCell = nearestCell(range.startContainer);
        const endCell = nearestCell(range.endContainer);
        if ((startCell || endCell) && startCell !== endCell) {
          const clamped = clampRangeToCell(range, startCell, endCell);
          if (clamped) {
            range = clamped;
            sel.removeAllRanges();
            sel.addRange(range);
          }
          // If clampRangeToCell returned null we still proceed with the original
          // range and let captureSelection fail/warn downstream — preserves the
          // explicit error path for genuinely un-clampable selections.
        }

        const text = sel.toString().trim();
        // Require at least 2 characters to avoid accidental single-letter comments
        // from stray click-drags. (Also catches the case where clamping shrank the
        // selection below the threshold — silent ignore is the right move there.)
        if (!text || text.length < 2) return;

        const captured = captureSelection(sel, text);
        if (!captured) {
          showError('Highlight a single passage — selections that cross images or sections can\'t be anchored.');
          sel.removeAllRanges();
          return;
        }

        const rect = range.getBoundingClientRect();
        pendingSelection = captured;
        pendingSelection._rectTop = rect.top;
        pendingSelection._range = range.cloneRange();

        const sidebarRect = document.querySelector('.sidebar-col').getBoundingClientRect();
        showNewCommentForm(pendingSelection, rect.top - sidebarRect.top);
      }, 250);
    });

    // Image click → open a new-comment form anchored to the image.
    // The selection-based path doesn't fire on <img> (no text), so we handle it explicitly.
    document.addEventListener('click', (e) => {
      if (e.target.tagName !== 'IMG') return;
      const prose = document.getElementById('prose');
      if (!prose.contains(e.target)) return;
      if (document.getElementById('new-comment-form')) {
        // A draft is already open. Don't silently swallow this click — surface the existing form.
        e.preventDefault();
        nudgeOpenForm();
        return;
      }
      e.preventDefault();
      const img = e.target;
      const alt = img.alt || '';
      const quote = '[image: ' + alt + ']';

      const rect = img.getBoundingClientRect();
      const sidebarRect = document.querySelector('.sidebar-col').getBoundingClientRect();
      pendingSelection = { quote, context_before: '', context_after: '' };
      pendingSelection._rectTop = rect.top;
      pendingSelection._img = img;
      showNewCommentForm(pendingSelection, rect.top - sidebarRect.top);
    }, true);

    // Close empty draft form when clicking outside it. NEVER silently destroy a typed draft —
    // if the user has typed anything, leave the form alone (Cancel/Escape are the explicit dismiss paths).
    document.addEventListener('mousedown', (e) => {
      if (selectionTimer) { clearTimeout(selectionTimer); selectionTimer = null; }
      const form = document.getElementById('new-comment-form');
      if (form && !form.contains(e.target) && isFormEmpty()) {
        dismissNewCommentForm();
      }
    });

    function isFormEmpty() {
      const ta = document.querySelector('#new-comment-form textarea');
      return !ta || ta.value.trim() === '';
    }

    // Surface the existing draft form when the user tries to start a new comment.
    // Pulses the textarea border and refocuses so they know where their in-progress draft is.
    function nudgeOpenForm() {
      const form = document.getElementById('new-comment-form');
      if (!form) return;
      form.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const ta = form.querySelector('textarea');
      if (ta) {
        ta.focus();
        ta.style.borderColor = 'var(--accent)';
        ta.style.boxShadow = '0 0 0 3px rgba(217,119,6,0.25)';
        setTimeout(() => { ta.style.boxShadow = ''; }, 600);
      }
    }

    function showNewCommentForm(selection, formTop) {
      document.getElementById('new-comment-form')?.remove();
      removePendingHighlight();
      window.getSelection()?.removeAllRanges();

      if (selection._range) applyPendingHighlight(selection._range);
      else if (selection._img) applyPendingImgHighlight(selection._img);

      const form = document.createElement('div');
      form.id = 'new-comment-form';
      form.className = 'new-comment-form';
      form.style.top = Math.max(0, formTop) + 'px';

      const body = document.createElement('div');
      body.className = 'new-comment-body';

      const textarea = document.createElement('textarea');
      textarea.className = 'reply-input';
      textarea.placeholder = 'Leave a comment…';
      body.appendChild(textarea);

      const actions = document.createElement('div');
      actions.className = 'new-comment-actions';

      const cancel = document.createElement('button');
      cancel.className = 'btn-cancel-inline';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => {
        dismissNewCommentForm();
      });

      const save = document.createElement('button');
      save.className = 'reply-submit';
      save.innerHTML = 'Save <kbd>⌘↵</kbd>';
      save.addEventListener('click', () => saveComment(form, textarea, selection));

      textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveComment(form, textarea, selection);
        if (e.key === 'Escape') {
          dismissNewCommentForm();
        }
      });

      actions.appendChild(cancel);
      actions.appendChild(save);
      body.appendChild(actions);
      form.appendChild(body);

      const sidebar = document.querySelector('.sidebar-col');
      sidebar.appendChild(form);
      textarea.focus();
      positionCards();
      // Re-arm the size observer so this new form participates in auto-reposition.
      observeCardSizes();

      // Clamp top so the form's bottom doesn't run past the sidebar.
      // Has to wait one frame for layout so offsetHeight is real.
      requestAnimationFrame(() => {
        const sidebarHeight = sidebar.getBoundingClientRect().height;
        const formHeight = form.offsetHeight;
        const desiredTop = parseFloat(form.style.top) || 0;
        const maxTop = Math.max(0, sidebarHeight - formHeight - 8);
        if (desiredTop > maxTop) form.style.top = maxTop + 'px';
      });
    }

    function dismissNewCommentForm() {
      const form = document.getElementById('new-comment-form');
      if (form) form.remove();
      removePendingHighlight();
      pendingSelection = null;
      positionCards();
    }

    function applyPendingHighlight(range) {
      const ancestor = range.commonAncestorContainer;
      const root = ancestor.nodeType === Node.TEXT_NODE ? ancestor.parentNode : ancestor;

      // Collect intersecting text nodes before mutating the DOM
      const textNodes = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node;
      while (node = walker.nextNode()) {
        if (range.intersectsNode(node)) textNodes.push(node);
      }

      for (const tn of textNodes) {
        const start = (tn === range.startContainer) ? range.startOffset : 0;
        const end = (tn === range.endContainer) ? range.endOffset : tn.nodeValue.length;
        if (start >= end) continue;

        const mark = document.createElement('mark');
        mark.className = 'rl-highlight rl-pending';
        mark.dataset.commentId = 'pending';

        const mid = tn.splitText(start);
        mid.splitText(end - start);
        mid.parentNode.insertBefore(mark, mid);
        mark.appendChild(mid);
      }
    }

    function applyPendingImgHighlight(img) {
      const mark = document.createElement('mark');
      mark.className = 'rl-highlight rl-pending rl-img';
      mark.dataset.commentId = 'pending';
      img.parentNode.insertBefore(mark, img);
      mark.appendChild(img);
    }

    function removePendingHighlight() {
      const prose = document.getElementById('prose');
      prose.querySelectorAll('[data-comment-id="pending"]').forEach(m => {
        const parent = m.parentNode;
        while (m.firstChild) parent.insertBefore(m.firstChild, m);
        parent.removeChild(m);
      });
      prose.normalize();
    }

    function captureSelection(sel, text) {
      return _captureSelection(document.getElementById('prose'), sel, text);
    }

    async function saveComment(form, textarea, selection) {
      const message = textarea.value.trim();
      if (!message) {
        textarea.focus();
        textarea.style.borderColor = 'var(--accent)';
        textarea.placeholder = 'Type a comment first…';
        return;
      }

      try {
        const res = await fetch('/api/comment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...selection, message }),
        });
        const data = await res.json();
        if (data.ok) {
          form.remove();
          removePendingHighlight();
          // Avoid duplicating if SSE comment-added already pushed via softRefresh
          if (!comments.some(c => c.id === data.comment.id)) {
            comments.push(data.comment);
          }
          thinkingCommentIds.add(data.comment.id);
          pendingSelection = null;
          window.getSelection()?.removeAllRanges();
          renderComments();
          applyHighlights();
          applyRoundState();
          focusComment(data.comment.id);
          updateNav();
          // Scroll the new card into view so the user sees the save landed
          const newCard = document.getElementById('card-' + data.comment.id);
          if (newCard) newCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else {
          showError(data.error || 'Failed to save comment');
        }
      } catch (err) {
        showError('Failed to save comment: ' + err.message);
      }
    }

    // ── Highlights ───────────────────────────────────────────────────
    // Run a DOM-mutating callback while pinning scroll position.
    // Uses requestAnimationFrame to clamp scroll for two frames after the mutation
    // — this catches focus-loss scrolls and layout-induced jumps that fire after the call returns.
    let deliberateScrollUntil = 0;
    function preserveScroll(fn) {
      _preserveScroll(fn, {
        skip: Date.now() < deliberateScrollUntil,
        protectFocusSelector: '#new-comment-form',
      });
    }

    function applyHighlights() {
      preserveScroll(() => {
        const prose = document.getElementById('prose');
        prose.querySelectorAll('mark.rl-highlight').forEach(m => {
          const parent = m.parentNode;
          while (m.firstChild) parent.insertBefore(m.firstChild, m);
          parent.removeChild(m);
        });
        prose.normalize();
        comments.forEach(comment => {
          highlightText(prose, comment.quote, comment.id, comment.resolved, comment.context_before || '');
        });
      });
    }

    function highlightText(container, text, id, resolved, contextBefore) {
      const marks = _highlightText(container, text, id, resolved, contextBefore);
      // lib's highlightText returns the marks; main.js owns the click handlers
      // because they call into focusComment/updateNav (UI concerns lib doesn't know about).
      // Image marks call focusComment only — text marks also refresh nav.
      marks.forEach(m => {
        if (m.classList.contains('rl-img')) {
          m.addEventListener('click', (e) => { e.stopPropagation(); focusComment(id); });
        } else {
          m.addEventListener('click', (e) => { e.stopPropagation(); focusComment(id); updateNav(); });
        }
      });
    }

    let navIdx = 0; // index into the unresolved comment list

    function focusComment(id) {
      document.querySelectorAll('.comment-card').forEach(el => el.classList.remove('active'));
      document.querySelectorAll('mark.rl-highlight').forEach(el => el.classList.remove('active'));
      const card = document.getElementById('card-' + id);
      if (card) card.classList.add('active');
      document.querySelectorAll('[data-comment-id="' + id + '"]').forEach(el => el.classList.add('active'));
      positionCards();
    }

    function clearFocus() {
      document.querySelectorAll('.comment-card').forEach(el => el.classList.remove('active'));
      document.querySelectorAll('mark.rl-highlight').forEach(el => el.classList.remove('active'));
      positionCards();
    }

    document.addEventListener('click', (e) => {
      const inCard = e.target.closest('.comment-card, .new-comment-form');
      const inMark = e.target.closest('mark.rl-highlight');
      const inNav  = e.target.closest('#comment-nav');
      if (!inCard && !inMark && !inNav) clearFocus();
    });

    function navigateTo(id) {
      focusComment(id);
      positionCards();
      // Scroll highlight into view in the prose
      const mark = document.querySelector('[data-comment-id="' + id + '"]');
      if (mark) mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    function updateNav() {
      const nav = document.getElementById('comment-nav');
      const countEl = document.getElementById('nav-count');
      const prevBtn = document.getElementById('nav-prev');
      const nextBtn = document.getElementById('nav-next');
      const activeCard = document.querySelector('.comment-card.active');
      const activeId = activeCard ? activeCard.id.replace(/^card-/, '') : null;
      const state = computeNavState(comments, activeId, navIdx);
      navIdx = state.navIdx;
      if (!state.visible) { nav.style.display = 'none'; return; }
      nav.style.display = 'flex';
      countEl.textContent = state.countText;
      prevBtn.style.display = state.showPrev ? '' : 'none';
      prevBtn.textContent = '↑ Prev';
      prevBtn.disabled = state.prevDisabled;
      nextBtn.style.display = '';
      nextBtn.textContent = state.nextLabel;
      nextBtn.disabled = state.nextDisabled;
    }

    document.getElementById('nav-prev').addEventListener('click', () => {
      const open = comments.filter(c => !c.resolved);
      if (navIdx > 0) { navIdx--; navigateTo(open[navIdx].id); updateNav(); }
    });
    document.getElementById('nav-next').addEventListener('click', () => {
      const open = comments.filter(c => !c.resolved);
      if (open.length === 1) {
        navigateTo(open[0].id);
      } else if (navIdx < open.length - 1) {
        navIdx++;
        navigateTo(open[navIdx].id);
        updateNav();
      }
    });

    // Debounced rAF wrapper around positionCards. Multiple callers in a single
    // tick coalesce into one layout pass.
    let _positionRafId = 0;
    function schedulePositionCards() {
      if (_positionRafId) return;
      _positionRafId = requestAnimationFrame(() => {
        _positionRafId = 0;
        positionCards();
      });
    }

    // ResizeObserver re-runs positionCards whenever any card or the open
    // new-comment-form changes height. Catches the cases where positionCards
    // was called before content settled (e.g. SSE softRefresh delivers a
    // larger reply than the initial card sized for, an agent verdict footer
    // appears or disappears, a resolved card collapses/expands).
    // Without this, the explicit positionCards() calls all assume size is
    // final at call time — which usually holds but occasionally doesn't,
    // producing the visible card-overlap bug surfaced in real usage.
    const _cardResizeObserver = (typeof ResizeObserver !== 'undefined')
      ? new ResizeObserver(() => schedulePositionCards())
      : null;
    function observeCardSizes() {
      if (!_cardResizeObserver) return;
      _cardResizeObserver.disconnect();
      document.querySelectorAll('.comment-card, #new-comment-form').forEach(el => {
        _cardResizeObserver.observe(el);
      });
    }

    function positionCards() {
      const sidebarCol = document.querySelector('.sidebar-col');
      if (!sidebarCol) return;
      const sidebarRect = sidebarCol.getBoundingClientRect();

      const items = [];
      let fallbackTop = 0;
      comments.forEach(comment => {
        const card = document.getElementById('card-' + comment.id);
        if (!card) return;
        const mark = document.querySelector('[data-comment-id="' + comment.id + '"]');
        let ideal;
        if (mark) {
          const markRect = mark.getBoundingClientRect();
          ideal = Math.max(0, markRect.top - sidebarRect.top);
          fallbackTop = Math.max(fallbackTop, ideal + card.offsetHeight + 14);
        } else {
          // No highlight anchor (e.g. read-only view of past round) — stack sequentially
          ideal = fallbackTop;
          fallbackTop += card.offsetHeight + 14;
        }
        items.push({
          el: card,
          ideal,
          active: card.classList.contains('active'),
        });
      });

      // Treat the open new-comment-form as an active anchor so cards cascade
      // around it instead of overlapping. It always wins activeness.
      const form = document.getElementById('new-comment-form');
      if (form) {
        const pendingMark = document.querySelector('[data-comment-id="pending"]');
        let ideal;
        if (pendingMark) {
          ideal = Math.max(0, pendingMark.getBoundingClientRect().top - sidebarRect.top);
        } else if (pendingSelection?._rectTop != null) {
          ideal = Math.max(0, pendingSelection._rectTop - sidebarRect.top);
        } else {
          ideal = parseFloat(form.style.top) || 0;
        }
        // Demote any previously-active card so the form takes the active slot
        items.forEach(item => { item.active = false; });
        items.push({ el: form, ideal, active: true });
      }

      if (items.length === 0) return;
      items.sort((a, b) => a.ideal - b.ideal);

      const activeIdx = items.findIndex(item => item.active);

      if (activeIdx === -1) {
        // No active card — simple downward cascade
        let minTop = 0;
        items.forEach(({ el, ideal }) => {
          const top = Math.max(ideal, minTop);
          el.style.top = top + 'px';
          minTop = top + el.offsetHeight + 14;
        });
        return;
      }

      // Active card gets its ideal position; others cascade around it
      const active = items[activeIdx];
      active.el.style.top = active.ideal + 'px';

      // Cards above: cascade upward from active card's top edge
      let ceiling = active.ideal - 14;
      for (let i = activeIdx - 1; i >= 0; i--) {
        const { el, ideal } = items[i];
        const top = Math.max(0, Math.min(ideal, ceiling - el.offsetHeight));
        el.style.top = top + 'px';
        ceiling = top - 14;
      }

      // Cards below: cascade downward from active card's bottom edge
      let floor = active.ideal + active.el.offsetHeight + 14;
      for (let i = activeIdx + 1; i < items.length; i++) {
        const { el, ideal } = items[i];
        const top = Math.max(ideal, floor);
        el.style.top = top + 'px';
        floor = top + el.offsetHeight + 14;
      }
    }

    // ── Comments sidebar ─────────────────────────────────────────────

    // Snapshot the focused textarea (if any) before the sidebar is rebuilt,
    // and snapshot every open reply form's typed draft. The DOM rebuild
    // destroys both — without preservation, an SSE event from a different
    // comment yanks focus and erases the user's mid-typed reply.
    function captureTypingState() {
      const state = { focused: null, drafts: [] };

      const active = document.activeElement;
      if (active && active.tagName === 'TEXTAREA') {
        const newForm = active.closest('#new-comment-form');
        const replyForm = active.closest('.reply-form');
        const card = active.closest('.comment-card');
        if (newForm) {
          state.focused = {
            kind: 'new',
            value: active.value,
            selectionStart: active.selectionStart,
            selectionEnd: active.selectionEnd,
          };
        } else if (replyForm && card && card.id) {
          state.focused = {
            kind: 'reply',
            commentId: card.id.replace('card-', ''),
            value: active.value,
            selectionStart: active.selectionStart,
            selectionEnd: active.selectionEnd,
          };
        }
      }

      // Capture every open reply form's draft, not just the focused one — the
      // user may have multiple drafts open and we shouldn't silently wipe the
      // ones they aren't currently typing in.
      document.querySelectorAll('.reply-form.open').forEach(form => {
        const ta = form.querySelector('.reply-input');
        const card = form.closest('.comment-card');
        if (!ta || !card || !card.id) return;
        if (!ta.value) return;
        state.drafts.push({
          commentId: card.id.replace('card-', ''),
          value: ta.value,
          selectionStart: ta.selectionStart,
          selectionEnd: ta.selectionEnd,
        });
      });

      return state;
    }

    function restoreTypingState(state) {
      // Restore drafts first so the form is open and populated; then restore
      // focus + selection if applicable.
      state.drafts.forEach(d => {
        const card = document.getElementById('card-' + d.commentId);
        if (!card) return;
        const form = card.querySelector('.reply-form');
        if (!form) return;
        const ta = form.querySelector('.reply-input');
        if (!ta) return;
        form.classList.add('open');
        ta.value = d.value;
      });

      const f = state.focused;
      if (!f) return;
      let target = null;
      if (f.kind === 'new') {
        target = document.querySelector('#new-comment-form textarea');
      } else if (f.kind === 'reply') {
        const card = document.getElementById('card-' + f.commentId);
        if (card) {
          const form = card.querySelector('.reply-form');
          if (form) {
            form.classList.add('open');
            target = form.querySelector('.reply-input');
          }
        }
      }
      if (!target) return;
      // Restore the value before setting selection — the textarea is freshly
      // built and starts empty.
      target.value = f.value;
      // preventScroll so re-focusing doesn't scroll the textarea into view
      // (preserveScroll already pinned the page; we don't want to fight it).
      try { target.focus({ preventScroll: true }); } catch { target.focus(); }
      try { target.setSelectionRange(f.selectionStart, f.selectionEnd); } catch {}
    }

    function renderComments() {
      const typing = captureTypingState();
      preserveScroll(() => {
        const sidebar = document.querySelector('.sidebar-col');

        // Preserve active card across rebuild (SSE softRefresh would otherwise wipe it).
        const activeCard = sidebar.querySelector('.comment-card.active');
        const activeId = activeCard ? activeCard.id.replace(/^card-/, '') : null;

        sidebar.querySelectorAll('.comment-card').forEach(el => el.remove());

        comments.forEach(comment => {
          sidebar.appendChild(buildCommentCard(comment));
        });

        if (activeId) {
          const restored = document.getElementById('card-' + activeId);
          if (restored) restored.classList.add('active');
          document.querySelectorAll('mark.rl-highlight[data-comment-id="' + activeId + '"]').forEach(el => el.classList.add('active'));
        }
      });
      // Re-arm the size observer against the freshly-built cards. Old observed
      // nodes are detached and will be GC'd; disconnect+re-observe keeps the
      // observer set in sync with the live DOM.
      observeCardSizes();
      restoreTypingState(typing);
    }

    function buildCommentCard(comment) {
      const card = document.createElement('div');
      card.className = 'comment-card' + (comment.resolved ? ' resolved' : '');
      card.id = 'card-' + comment.id;

      const quote = document.createElement('div');
      quote.className = 'comment-quote';
      if (comment.resolved) {
        const badge = document.createElement('span');
        badge.className = 'resolved-badge';
        badge.textContent = '✓ Resolved';
        quote.appendChild(badge);
        const verdict = latestVerdict(comment);
        if (verdict) {
          const vbadge = document.createElement('span');
          vbadge.className = 'verdict-badge ' + verdict;
          vbadge.textContent = verdict === 'revise' ? '✎ Edit queued' : '✓ Answered';
          quote.appendChild(vbadge);
        }
      }
      quote.appendChild(document.createTextNode('"' + comment.quote + '"'));
      card.appendChild(quote);

      // For resolved cards: show a short commitment summary (visible when collapsed).
      // Take the first sentence of the last agent reply, capped at 140 chars.
      if (comment.resolved) {
        const lastAgentMsg = [...comment.thread].reverse().find(e => e.role === 'agent');
        if (lastAgentMsg) {
          const full = lastAgentMsg.message;
          const sentenceEnd = full.search(/[.!?](\s|$)/);
          let summary = sentenceEnd !== -1 ? full.slice(0, sentenceEnd + 1) : full;
          if (summary.length > 140) summary = summary.slice(0, 137).trimEnd() + '…';
          const commitment = document.createElement('div');
          commitment.className = 'card-commitment';
          commitment.textContent = summary;
          card.appendChild(commitment);
        }
      }

      const thread = document.createElement('div');
      thread.className = 'comment-thread';
      thread.id = 'thread-' + comment.id;
      // Find the index of the latest agent reply that carries a verdict — only
      // that one's footer is "live." Earlier verdict footers describe edits
      // that have been superseded and would no longer happen at resolve time
      // (the resolve flow uses latestVerdict()), so showing them lies to the
      // user about what clicking Resolve will do.
      let latestVerdictIdx = -1;
      for (let i = comment.thread.length - 1; i >= 0; i--) {
        const e = comment.thread[i];
        if (e.role === 'agent' && typeof e.requires_revision === 'boolean') {
          latestVerdictIdx = i;
          break;
        }
      }
      comment.thread.forEach((entry, i) => {
        thread.appendChild(buildThreadEntry(entry, i === latestVerdictIdx));
      });
      if (thinkingCommentIds.has(comment.id)) {
        const indicator = document.createElement('div');
        indicator.className = 'thread-entry thinking-indicator';
        indicator.innerHTML = '<div class="thread-role agent">Agent</div><div class="thread-message thinking-dots"><span></span><span></span><span></span></div>';
        thread.appendChild(indicator);
      }
      // Wrap thread, actions, reply form in .comment-body (hidden when resolved + collapsed)
      const body = document.createElement('div');
      body.className = 'comment-body';

      body.appendChild(thread);

      const actions = document.createElement('div');
      actions.className = 'comment-actions';

      if (!comment.resolved && !roundResolved) {
        const replyBtn = document.createElement('button');
        replyBtn.className = 'btn-reply';
        replyBtn.textContent = 'Reply';
        replyBtn.addEventListener('click', () => toggleReplyForm(comment.id));
        actions.appendChild(replyBtn);

        const resolveBtn = document.createElement('button');
        const verdict = latestVerdict(comment);
        resolveBtn.className = 'btn-resolve-comment' + (verdict === 'revise' ? ' revise' : '');
        resolveBtn.textContent = verdict === 'revise' ? 'Resolve → queue edit' : 'Resolve';
        resolveBtn.addEventListener('click', () => resolveComment(comment.id));
        actions.appendChild(resolveBtn);
      }

      if (comment.resolved && !roundResolved) {
        const reopenBtn = document.createElement('button');
        reopenBtn.className = 'btn-reopen';
        reopenBtn.textContent = 'Reopen';
        reopenBtn.addEventListener('click', () => reopenComment(comment.id));
        actions.appendChild(reopenBtn);
      }

      body.appendChild(actions);

      const replyForm = document.createElement('div');
      replyForm.className = 'reply-form';
      replyForm.id = 'reply-' + comment.id;
      replyForm.innerHTML = `
        <textarea class="reply-input" placeholder="Reply…"></textarea>
        <button class="reply-submit">Send <kbd>⌘↵</kbd></button>
      `;
      replyForm.querySelector('.reply-submit').addEventListener('click', () => {
        submitReply(comment.id, replyForm.querySelector('.reply-input').value.trim());
      });
      replyForm.querySelector('.reply-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          submitReply(comment.id, replyForm.querySelector('.reply-input').value.trim());
        }
      });
      body.appendChild(replyForm);

      card.appendChild(body);

      // Resolved cards: click quote to expand/collapse; other clicks focus
      if (comment.resolved) {
        quote.addEventListener('click', (e) => {
          e.stopPropagation();
          card.classList.toggle('expanded');
          positionCards();
        });
      }

      card.addEventListener('click', (e) => {
        if (e.target.tagName === 'BUTTON' || e.target.tagName === 'TEXTAREA') return;
        if (comment.resolved) return; // handled by quote click
        focusComment(comment.id);
        updateNav();
      });

      return card;
    }

    function buildThreadEntry(entry, isLatestVerdict) {
      const role = entry.role ?? 'agent';
      const label = entry.name ?? (role === 'agent' ? 'Agent' : 'Human');
      const div = document.createElement('div');
      div.className = 'thread-entry';
      let verdictHtml = '';
      // Only show a verdict footer on the latest verdict-bearing agent reply,
      // and only when that latest verdict implies an edit. Earlier verdict
      // footers describe edits that have been superseded by subsequent turns
      // — keeping them visible would lie about what Resolve will do. Plain
      // "answered" replies stay footer-less (the absence is the signal).
      if (role === 'agent' && entry.requires_revision === true && isLatestVerdict) {
        const reason = entry.revision_reason ? escapeHtml(entry.revision_reason) : 'edit queued';
        verdictHtml = `<div class="verdict revise"><span class="verdict-icon">✎</span><span>${reason}</span></div>`;
      }
      div.innerHTML = `
        <div class="thread-role ${role}">${escapeHtml(label)}</div>
        <div class="thread-message">${escapeHtml(entry.message)}</div>
        ${verdictHtml}
      `;
      return div;
    }

    function toggleReplyForm(id) {
      const form = document.getElementById('reply-' + id);
      const card = document.getElementById('card-' + id);
      form.classList.toggle('open');
      if (form.classList.contains('open')) {
        form.querySelector('.reply-input').focus();
        if (card) card.style.zIndex = '1';
      } else {
        if (card) card.style.zIndex = '';
      }
      // Card height changed — re-cascade so siblings shift instead of overlapping.
      positionCards();
    }

    async function submitReply(id, message) {
      if (!message) return;
      try {
        const res = await fetch('/api/comment/' + id + '/reply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: 'human', message }),
        });
        const data = await res.json();
        if (data.ok) {
          const idx = comments.findIndex(c => c.id === id);
          if (idx !== -1) comments[idx] = data.comment;
          thinkingCommentIds.add(id);
          renderComments();
          positionCards();
          updateNav();
        } else {
          showError(data.error || 'Failed to save reply');
        }
      } catch (err) {
        showError('Failed to save reply: ' + err.message);
      }
    }

    async function resolveComment(id) {
      try {
        const res = await fetch('/api/comment/' + id + '/resolve', { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
          const c = comments.find(c => c.id === id);
          if (c) c.resolved = true;
          navIdx = 0;
          renderComments();
          applyHighlights();
          positionCards();
          updateNav();
          applyRoundState();
          if (data.allResolved) {
            deliberateScrollUntil = Date.now() + 1200;
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }
        } else {
          showError(data.error || 'Failed to resolve comment');
        }
      } catch (err) {
        showError('Failed to resolve: ' + err.message);
      }
    }

    async function reopenComment(id) {
      try {
        const res = await fetch('/api/comment/' + id + '/reopen', { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
          const idx = comments.findIndex(c => c.id === id);
          if (idx !== -1) comments[idx] = data.comment;
          renderComments();
          applyHighlights();
          positionCards();
          updateNav();
          applyRoundState();
        } else {
          showError(data.error || 'Failed to reopen comment');
        }
      } catch (err) {
        showError('Failed to reopen: ' + err.message);
      }
    }

    function showError(msg) {
      const el = document.getElementById('error-banner');
      el.textContent = msg;
      el.style.display = 'block';
      setTimeout(() => el.style.display = 'none', 4000);
    }

    // ── Round state display ──────────────────────────────────────────
    function applyRoundState() {
      const btnAccept = document.getElementById('btn-accept');
      const banner = document.getElementById('sidebar-status-banner');
      if (!btnAccept) return; // read-only view

      // If a revision error is currently surfaced, leave the banner alone —
      // it gets cleared explicitly when the user retries the revision.
      const errorShowing = !!banner?.classList.contains('error');

      if (roundResolved) {
        document.getElementById('empty-rail-hint')?.remove();
        document.getElementById('round-secondary')?.remove();
        btnAccept.disabled = true;
        btnAccept.textContent = '✓ Accepted';
        if (banner && !errorShowing) {
          banner.innerHTML = '<div class="revising-header"><span class="revising-spinner"></span><span>Revising the document<span class="revising-dots"><span>.</span><span>.</span><span>.</span></span></span></div><div id="revision-stream"></div>';
          banner.classList.add('revising');
          banner.style.display = 'flex';
        }
        renderComments();
        positionCards();
        updateNav();
      } else if (comments.length === 0) {
        document.getElementById('round-secondary')?.remove();
        btnAccept.disabled = false;
        // Whether this is a cold-open or a post-revision empty round, the
        // human's action is the same: "I've read it, sign off." The old
        // "Skip review" label suggested bailing without engaging — but
        // sometimes the doc is fine on first read and that's a real approval.
        btnAccept.textContent = 'Accept doc';
        btnAccept.dataset.mode = 'finish';
        if (banner && !errorShowing) {
          banner.classList.remove('revising');
          banner.style.display = 'none';
        }
        // Surface a "Select text to leave a comment" hint only on cold-open.
        // Subsequent empty rounds already showed the hint once; repeating it
        // would be noise.
        const hint = document.getElementById('empty-rail-hint');
        const isColdOpen = totalRounds <= 1;
        if (isColdOpen) {
          if (!hint) {
            const rail = document.querySelector('.sidebar-col');
            if (rail) {
              const el = document.createElement('div');
              el.id = 'empty-rail-hint';
              el.className = 'empty-rail-hint';
              el.textContent = 'Select text to leave a comment.';
              rail.appendChild(el);
            }
          }
        } else if (hint) {
          hint.remove();
        }
      } else {
        document.getElementById('empty-rail-hint')?.remove();
        const hasOpen = comments.some(c => !c.resolved);
        btnAccept.disabled = hasOpen;
        // Strip any prior secondary action; we re-add it below if applicable.
        document.getElementById('round-secondary')?.remove();
        if (hasOpen) {
          btnAccept.dataset.mode = 'accept';
          btnAccept.classList.remove('revise-tinted');
          btnAccept.textContent = 'Revise document';
          if (banner && !errorShowing) {
            banner.classList.remove('revising');
            banner.style.display = 'none';
          }
        } else {
          // All resolved — pick default action by majority verdict.
          // Any 'revise' wins (safe default: revising more is cheaper than missing an edit).
          const verdicts = comments.map(latestVerdict);
          const reviseCount = verdicts.filter(v => v === 'revise').length;
          const total = verdicts.length;
          const anyRevise = reviseCount > 0;

          btnAccept.dataset.mode = anyRevise ? 'accept' : 'finish';
          btnAccept.textContent = anyRevise ? 'Revise document' : 'Accept as-is';

          if (banner && !errorShowing) {
            banner.classList.remove('revising');
            let bannerText;
            if (reviseCount === 0) {
              bannerText = total === 1
                ? 'Comment answered in thread — no revision needed.'
                : `All ${total} comments answered in thread — no revision needed.`;
            } else if (reviseCount === total) {
              bannerText = total === 1
                ? 'Comment implies an edit — ready to revise.'
                : `All ${total} comments imply edits — ready to revise.`;
            } else {
              bannerText = `${reviseCount} of ${total} comments imply edits.`;
            }
            banner.textContent = bannerText;
            banner.style.display = 'block';
          }

          // Secondary action — the opposite of the default.
          const sidebar = document.querySelector('.sidebar-col');
          if (sidebar) {
            const sec = document.createElement('div');
            sec.id = 'round-secondary';
            sec.className = 'round-secondary';
            const altLabel = anyRevise ? 'accept as-is without revising' : 'revise the document anyway';
            sec.innerHTML = `or <button id="round-secondary-btn">${altLabel}</button>`;
            // Insert right after the banner so it sits with the round-level controls.
            banner?.insertAdjacentElement('afterend', sec) ?? sidebar.appendChild(sec);
            sec.querySelector('#round-secondary-btn').addEventListener('click', () => {
              if (anyRevise) {
                // User is overriding to skip revision despite implied edits — confirm.
                const msg = reviseCount === 1
                  ? '1 comment suggested an edit. Accept anyway?'
                  : `${reviseCount} comments suggested edits. Accept anyway?`;
                if (!confirm(msg)) return;
                triggerRoundAction('finish');
              } else {
                triggerRoundAction('accept');
              }
            });
          }
        }
      }
    }

    // Trigger the same flow as clicking the primary button, but for an
    // arbitrary mode ('accept' | 'finish'). Used by the secondary action link.
    async function triggerRoundAction(mode) {
      const btnAccept = document.getElementById('btn-accept');
      const banner = document.getElementById('sidebar-status-banner');
      if (banner) {
        banner.classList.remove('error');
        banner.style.display = 'none';
        banner.textContent = '';
      }
      const endpoint = mode === 'finish' ? '/api/finish' : '/api/accept';
      const res = await fetch(endpoint, { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        roundResolved = true;
        document.getElementById('round-secondary')?.remove();
        if (mode === 'finish') {
          if (btnAccept) { btnAccept.disabled = true; btnAccept.textContent = '✓ Done'; }
          if (banner) {
            banner.classList.remove('revising'); banner.classList.remove('error');
            banner.textContent = 'Review complete. Document is ready.';
            banner.style.display = 'block';
          }
        } else {
          applyRoundState();
        }
      } else {
        alert(data.error || 'Could not complete.');
      }
    }

    document.getElementById('btn-accept')?.addEventListener('click', () => {
      const btnAccept = document.getElementById('btn-accept');
      if (btnAccept?.disabled) return;
      triggerRoundAction(btnAccept.dataset.mode);
    });

    // ── Revision banner ──────────────────────────────────────────────
    function showRevisionBanner() {
      if (document.getElementById('revision-banner')) return;
      const banner = document.createElement('div');
      banner.id = 'revision-banner';
      banner.className = 'revision-banner';
      banner.innerHTML = '<span class="revision-banner-text">Document revised.</span>' +
        '<button class="revision-banner-link" id="revision-banner-diff">See what changed →</button>' +
        '<button class="revision-banner-dismiss" aria-label="Dismiss">✕</button>';
      banner.querySelector('#revision-banner-diff').addEventListener('click', () => {
        banner.remove();
        showDiffOverlay();
      });
      banner.querySelector('.revision-banner-dismiss').addEventListener('click', () => banner.remove());
      const prose = document.getElementById('prose');
      prose.parentNode.insertBefore(banner, prose);
    }

    // ── Diff overlay ─────────────────────────────────────────────────
    async function showDiffOverlay() {
      const res = await fetch('/api/diff');
      const data = await res.json();
      if (!data.ok) return;
      document.getElementById('diff-panel-body').innerHTML = data.html;
      document.getElementById('diff-overlay').classList.add('open');
    }

    document.getElementById('btn-compare')?.addEventListener('click', () => showDiffOverlay());

    document.getElementById('diff-btn-accept').addEventListener('click', async () => {
      document.getElementById('diff-overlay').classList.remove('open');
      await fetch('/api/finish', { method: 'POST' });
      const btnAccept = document.getElementById('btn-accept');
      if (btnAccept) { btnAccept.disabled = true; btnAccept.textContent = '✓ Done'; }
      const banner = document.getElementById('sidebar-status-banner');
      if (banner) {
        banner.classList.remove('revising');
        banner.textContent = 'Review complete. Document is ready.';
        banner.style.display = 'block';
      }
    });

    document.getElementById('diff-btn-feedback').addEventListener('click', () => {
      document.getElementById('diff-overlay').classList.remove('open');
    });

    document.getElementById('diff-btn-close')?.addEventListener('click', () => {
      document.getElementById('diff-overlay').classList.remove('open');
    });

    // ── Round picker ─────────────────────────────────────────────────
    const roundBadge = document.getElementById('round-badge');
    const roundPicker = document.getElementById('round-picker');
    if (roundBadge && roundPicker) {
      roundBadge.addEventListener('click', (e) => {
        e.stopPropagation();
        roundPicker.style.display = roundPicker.style.display === 'none' ? 'block' : 'none';
      });
      document.addEventListener('click', () => { roundPicker.style.display = 'none'; });
    }

    // ── Context banner ───────────────────────────────────────────────
    function dismissContextBanner() {
      const banner = document.getElementById('context-banner');
      if (banner) banner.remove();
      try { localStorage.setItem('rl-ctx-dismissed-' + (window).__REDLINE__.contextTitle, '1'); } catch {}
    }
    (function() {
      const banner = document.getElementById('context-banner');
      if (!banner) return;
      try {
        if (localStorage.getItem('rl-ctx-dismissed-' + (window).__REDLINE__.contextTitle)) banner.remove();
      } catch {}
    })();

    // Replace broken images with a styled placeholder showing the alt text.
    function swapBrokenImg(img) {
      const placeholder = document.createElement('div');
      placeholder.className = 'broken-img';
      placeholder.textContent = 'Image failed to load' + (img.alt ? ': ' + img.alt : '');
      img.replaceWith(placeholder);
    }
    document.querySelectorAll('#prose img').forEach(img => {
      img.addEventListener('error', () => swapBrokenImg(img));
      // Image may already have errored before our listener attached (cached failure,
      // or the request raced ahead of script eval). Detect via the standard pattern.
      if (img.complete && img.naturalWidth === 0) swapBrokenImg(img);
    });

    // ── Init ─────────────────────────────────────────────────────────
    // Syntax-highlight code blocks before applyHighlights wraps comment marks,
    // so hljs tokenization happens against raw text and our <mark>s sit on top.
    if (window.hljs) {
      // Only highlight blocks with an explicit language tag — hljs's auto-detection
      // mis-tokenizes plain prose in unlabelled code blocks.
      document.querySelectorAll('#prose pre code[class*="language-"]').forEach(el => {
        try { window.hljs.highlightElement(el); } catch (e) { /* unknown language — leave as-is */ }
      });
    }

    renderComments();
    applyHighlights();
    positionCards();
    updateNav();
    applyRoundState();
    if (sessionStorage.getItem('just-revised')) {
      sessionStorage.removeItem('just-revised');
      showRevisionBanner();
    }
    if (sessionStorage.getItem('rl-no-changes')) {
      sessionStorage.removeItem('rl-no-changes');
      const banner = document.getElementById('sidebar-status-banner');
      if (banner) {
        banner.classList.remove('revising'); banner.classList.remove('error');
        banner.textContent = 'No changes — the document is unchanged.';
        banner.style.display = 'block';
        setTimeout(() => { banner.style.display = 'none'; }, 5000);
      }
    }
    window.addEventListener('scroll', positionCards, { passive: true });
    window.addEventListener('resize', positionCards, { passive: true });

    // ── SSE auto-reload ───────────────────────────────────────────────
    async function softRefresh({ rehighlight = false } = {}) {
      try {
        const res = await fetch('/api/comments');
        const data = await res.json();
        // If a new round was created while we were disconnected (missed reload event),
        // the only safe thing is to reload — the page state is from a stale round.
        if (typeof data.totalRounds === 'number' && data.totalRounds > totalRounds) {
          window.location.reload();
          return;
        }
        comments = data.comments;
        roundResolved = data.roundResolved;
        renderComments();
        if (rehighlight) applyHighlights();
        positionCards();
        updateNav();
        applyRoundState();
      } catch { /* non-fatal */ }
    }

    let sseHasConnectedOnce = false;
    let currentEs = null;
    let lastEventAt = Date.now();

    // Force-reconnect helper: closes the current EventSource so the existing
    // onerror → setTimeout(connectEvents, 3000) chain takes over. We schedule
    // connectEvents directly here in case the EventSource is a zombie that
    // never fires onerror.
    function forceReconnect(reason) {
      try { console.warn('[redline] forcing SSE reconnect:', reason); } catch {}
      if (currentEs) { try { currentEs.close(); } catch {} currentEs = null; }
    }

    // ── Zombie-SSE recovery ──────────────────────────────────────────
    // If the tab was backgrounded during a long revision, the browser may
    // hold the SSE connection open but stop delivering events — neither
    // `onerror` nor any handler fires, so the existing reconnect-on-error
    // path doesn't recover. Two layered defenses:
    //   1. Visibility/focus → softRefresh: when the tab regains focus,
    //      reconcile state via /api/comments. softRefresh's totalRounds
    //      check force-reloads if a `reload` event was missed.
    //   2. Heartbeat watchdog: while a revision is actively running
    //      (.revising banner visible), the server streams revision-chunk
    //      events constantly. If we haven't seen ANY event for >30s in
    //      that state, the connection is a zombie — force a reconnect.
    function onVisibleOrFocus() {
      if (document.visibilityState === 'visible') {
        softRefresh({ rehighlight: true });
      }
    }
    document.addEventListener('visibilitychange', onVisibleOrFocus);
    window.addEventListener('focus', onVisibleOrFocus);

    setInterval(() => {
      const banner = document.getElementById('sidebar-status-banner');
      const revising = banner?.classList.contains('revising');
      if (!revising) return; // idle session — silence is fine
      const silenceMs = Date.now() - lastEventAt;
      if (silenceMs > 30_000) {
        forceReconnect(`no events for ${Math.round(silenceMs/1000)}s during revision`);
      }
    }, 5000);

    (function connectEvents() {
      const es = new EventSource('/api/events?client=browser');
      currentEs = es;
      lastEventAt = Date.now();
      // Wrap addEventListener so every event resets the heartbeat tracker.
      const on = (name, fn) => es.addEventListener(name, (e) => { lastEventAt = Date.now(); fn(e); });
      es.onopen = () => {
        lastEventAt = Date.now();
        if (sseHasConnectedOnce) {
          // Reconnected after a drop. Reconcile state — softRefresh will full-reload
          // if a new round was created while we were disconnected (missed reload event).
          softRefresh({ rehighlight: true });
        }
        sseHasConnectedOnce = true;
      };
      on('comment-thinking', (e) => {
        try { thinkingCommentIds.add(JSON.parse(e.data).commentId); } catch {}
        renderComments();
        positionCards();
        updateNav();
      });
      on('agent-replied', () => { thinkingCommentIds.clear(); softRefresh(); });
      on('comment-added', () => softRefresh({ rehighlight: true }));
      on('comment-reply', (e) => {
        try { thinkingCommentIds.delete(JSON.parse(e.data).commentId); } catch {}
        softRefresh();
      });
      on('comment-resolved', () => softRefresh({ rehighlight: true }));
      on('reload', () => { sessionStorage.setItem('just-revised', '1'); window.location.reload(); });
      on('revision-chunk', (e) => {
        try {
          const { text, kind } = JSON.parse(e.data);
          const stream = document.getElementById('revision-stream');
          if (stream) {
            if (stream.style.display === 'none' || !stream.style.display) stream.style.display = 'block';
            const span = document.createElement('span');
            span.className = kind === 'thinking' ? 'rs-thinking' : 'rs-text';
            span.textContent = text;
            stream.appendChild(span);
            stream.scrollTop = stream.scrollHeight;
          }
        } catch {}
      });
      on('revision-error', (e) => {
        let msg = 'Revision failed.';
        try { msg = 'Revision failed: ' + (JSON.parse(e.data).message ?? 'unknown error'); } catch {}
        softRefresh();
        const banner = document.getElementById('sidebar-status-banner');
        if (banner) {
          banner.classList.remove('revising'); banner.classList.remove('error');
          banner.classList.add('error');
          banner.textContent = msg + ' Click "Revise document" to retry.';
          banner.style.display = 'block';
        }
      });
      on('revision-stalled', (e) => {
        // Watchdog tripped — server has un-resolved the round and broadcast.
        // Reuse the revision-error UI path so the banner reads consistently.
        let msg = 'Revision did not complete.';
        try { msg = 'Revision did not complete: ' + (JSON.parse(e.data).message ?? 'unknown'); } catch {}
        softRefresh();
        const banner = document.getElementById('sidebar-status-banner');
        if (banner) {
          banner.classList.remove('revising'); banner.classList.remove('error');
          banner.classList.add('error');
          banner.textContent = msg + ' Click "Revise document" to retry.';
          banner.style.display = 'block';
        }
      });
      on('revision-no-changes', () => {
        // Stash the message and reload so the round badge / state catches up.
        // The init code below picks up the flag and surfaces the banner briefly.
        try { sessionStorage.setItem('rl-no-changes', '1'); } catch {}
        window.location.reload();
      });
      on('finished', () => {
        document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:system-ui;flex-direction:column;gap:16px;color:#374151"><div style="font-size:48px">✓</div><div style="font-size:20px;font-weight:600">Review complete</div><div style="color:#6b7280">You can close this tab and continue in Claude Code.</div></div>';
      });
      es.onerror = () => { es.close(); if (currentEs === es) currentEs = null; setTimeout(connectEvents, 3000); };
    })();
