// Pictaria Enrichment Queue Widget
// Slide-over sidebar for viewing and managing active enrichment runs and queue slices.
// Features persistent DOM nodes, in-place status updates, and individual photo deletion.

(function() {
  if (typeof window === 'undefined') return;

  const STYLES = `
    .p-queue-fab {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 998;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 9px 16px;
      border-radius: 999px;
      background: var(--p-panel, #151b23);
      border: 1px solid var(--p-line, #30363d);
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
      color: var(--p-ink, #e6edf3);
      cursor: pointer;
      font-weight: 700;
      font-size: 13px;
      user-select: none;
      transition: transform 120ms ease, background 120ms ease, border-color 120ms ease;
    }
    .p-queue-fab:hover {
      background: var(--p-panel-2, #1c242e);
      border-color: var(--p-muted, #8b949e);
      transform: translateY(-1px);
    }
    .p-queue-fab.hidden {
      display: none !important;
    }
    .p-queue-badge {
      background: var(--p-accent, #388bfd);
      color: var(--p-accent-ink, #ffffff);
      border-radius: 999px;
      padding: 1px 7px;
      font-size: 11px;
      font-weight: 800;
      min-width: 18px;
      text-align: center;
      line-height: 1.3;
    }
    .p-queue-pulse-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--p-ok, #22c55e);
      box-shadow: 0 0 6px var(--p-ok, #22c55e);
      animation: p-queue-pulse-anim 1.6s infinite ease-in-out;
      flex-shrink: 0;
    }
    @keyframes p-queue-pulse-anim {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.35; transform: scale(0.85); }
    }
    .p-queue-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.45);
      backdrop-filter: blur(2px);
      z-index: 999;
      opacity: 0;
      pointer-events: none;
      transition: opacity 200ms ease;
    }
    .p-queue-backdrop.open {
      opacity: 1;
      pointer-events: auto;
    }
    .p-queue-panel {
      position: fixed;
      top: 0;
      right: 0;
      bottom: 0;
      z-index: 1000;
      width: 540px;
      max-width: calc(100vw - 24px);
      height: 100vh;
      background: var(--p-panel, #151b23);
      border-left: 1px solid var(--p-line, #30363d);
      box-shadow: -8px 0 32px rgba(0, 0, 0, 0.5);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      font-family: var(--p-font, system-ui, -apple-system, sans-serif);
      color: var(--p-ink, #e6edf3);
      transform: translateX(100%);
      pointer-events: none;
      visibility: hidden;
      transition: transform 240ms cubic-bezier(0.16, 1, 0.3, 1), visibility 240ms;
    }
    .p-queue-panel.open {
      transform: translateX(0);
      pointer-events: auto;
      visibility: visible;
    }
    .p-queue-head {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 14px 18px;
      background: var(--p-panel, #151b23);
      border-bottom: 1px solid var(--p-line, #30363d);
      flex-shrink: 0;
    }
    .p-queue-head .title-wrap {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 700;
      font-size: 14.5px;
    }
    .p-queue-head .grow {
      flex: 1;
    }
    .p-queue-head-actions {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .p-queue-btn-icon {
      background: transparent;
      border: 1px solid transparent;
      color: var(--p-muted, #8b949e);
      border-radius: var(--p-radius-sm, 6px);
      cursor: pointer;
      padding: 4px 8px;
      font-size: 13px;
      line-height: 1;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .p-queue-btn-icon:hover {
      color: var(--p-ink, #e6edf3);
      background: var(--p-panel-2, #1c242e);
      border-color: var(--p-line, #30363d);
    }
    .p-queue-body {
      overflow-y: auto;
      flex: 1;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .p-queue-empty {
      padding: 36px 16px;
      text-align: center;
      color: var(--p-muted, #8b949e);
      font-size: 13px;
      line-height: 1.6;
    }
    .p-queue-card {
      background: var(--p-panel-2, #1c242e);
      border: 1px solid var(--p-line, #30363d);
      border-radius: var(--p-radius-sm, 6px);
      padding: 12px 14px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .p-queue-card.running {
      border-color: var(--p-accent, #388bfd);
      box-shadow: 0 0 0 1px var(--p-accent, #388bfd);
    }
    .p-queue-card-top {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .p-queue-reorder-group {
      display: flex;
      flex-direction: column;
      gap: 2px;
      flex-shrink: 0;
    }
    .p-queue-reorder-btn {
      width: 18px;
      height: 14px;
      padding: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--p-bg, #0d1117);
      border: 1px solid var(--p-line, #30363d);
      border-radius: 3px;
      color: var(--p-muted, #8b949e);
      cursor: pointer;
      font-size: 9px;
      line-height: 1;
    }
    .p-queue-reorder-btn:hover:not(:disabled) {
      color: var(--p-ink, #e6edf3);
      border-color: var(--p-muted, #8b949e);
    }
    .p-queue-reorder-btn:disabled {
      opacity: 0.25;
      cursor: not-allowed;
    }
    .p-queue-title-area {
      flex: 1;
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .p-queue-title-text {
      font-weight: 700;
      font-size: 13.5px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--p-ink, #e6edf3);
    }
    .p-queue-edit-btn {
      background: transparent;
      border: none;
      color: var(--p-muted, #8b949e);
      cursor: pointer;
      font-size: 11px;
      padding: 2px 4px;
      border-radius: 3px;
      opacity: 0.7;
    }
    .p-queue-edit-btn:hover {
      opacity: 1;
      color: var(--p-ink, #e6edf3);
      background: var(--p-bg, #0d1117);
    }
    .p-queue-title-input {
      flex: 1;
      min-width: 0;
      height: 26px;
      font-size: 13px;
      padding: 2px 8px;
      background: var(--p-bg, #0d1117);
      border: 1px solid var(--p-accent, #388bfd);
      color: var(--p-ink, #e6edf3);
      border-radius: var(--p-radius-sm, 6px);
    }
    .p-queue-actions {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
    }
    .p-queue-meta-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      font-size: 12px;
      color: var(--p-muted, #8b949e);
    }
    .p-queue-options-row {
      display: flex;
      align-items: center;
      gap: 14px;
      font-size: 12px;
      color: var(--p-muted, #8b949e);
      padding-top: 2px;
    }
    .p-queue-options-row label {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      cursor: pointer;
    }
    .p-queue-options-row input[type="checkbox"] {
      margin: 0;
      cursor: pointer;
    }
    .p-queue-progress-bar-wrap {
      width: 100%;
      height: 5px;
      background: var(--p-bg, #0d1117);
      border-radius: 999px;
      overflow: hidden;
      border: 1px solid var(--p-line, #30363d);
      margin: 4px 0 2px 0;
    }
    .p-queue-progress-bar-fill {
      height: 100%;
      background: var(--p-accent, #388bfd);
      border-radius: 999px;
      transition: width 240ms ease;
    }
    .p-queue-filter-pills {
      display: flex;
      align-items: center;
      gap: 5px;
      margin: 6px 0 4px 0;
      flex-wrap: wrap;
    }
    .p-queue-filter-pill {
      background: var(--p-bg, #0d1117);
      border: 1px solid var(--p-line, #30363d);
      color: var(--p-muted, #8b949e);
      border-radius: 999px;
      font-size: 11px;
      padding: 2px 8px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-weight: 600;
    }
    .p-queue-filter-pill.active {
      background: var(--p-accent, #388bfd);
      color: var(--p-accent-ink, #ffffff);
      border-color: var(--p-accent, #388bfd);
    }
    .p-queue-filter-pill:hover:not(.active) {
      border-color: var(--p-muted, #8b949e);
      color: var(--p-ink, #e6edf3);
    }
    .p-queue-photos-toggle {
      background: transparent;
      border: 1px solid var(--p-line, #30363d);
      color: var(--p-muted, #8b949e);
      border-radius: var(--p-radius-sm, 6px);
      font-size: 11.5px;
      padding: 2px 7px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .p-queue-photos-toggle:hover {
      color: var(--p-ink, #e6edf3);
      border-color: var(--p-muted, #8b949e);
    }
    .p-queue-active-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(68px, 1fr));
      gap: 8px;
      max-height: 380px;
      overflow-y: auto;
      padding: 6px 2px;
      scrollbar-width: thin;
      border-top: 1px solid var(--p-line, #30363d);
      margin-top: 4px;
    }
    .p-queue-photo-wrapper {
      position: relative;
      aspect-ratio: 1 / 1;
      border-radius: 6px;
      background: var(--p-bg, #0d1117);
    }
    .p-queue-photo-wrapper.hidden {
      display: none !important;
    }
    .p-queue-photo-thumb {
      width: 100%;
      height: 100%;
      border-radius: 6px;
      object-fit: cover;
      background: var(--p-bg, #0d1117);
      border: 1.5px solid var(--p-line, #30363d);
      display: block;
      transition: transform 100ms ease, border-color 100ms ease;
    }
    .p-queue-photo-thumb:hover {
      transform: scale(1.04);
      border-color: var(--p-accent, #388bfd);
    }
    .p-queue-photo-thumb.in_progress {
      border: 2px solid var(--p-accent, #388bfd);
      box-shadow: 0 0 8px var(--p-accent, #388bfd);
      animation: p-queue-pulse-anim 1.6s infinite ease-in-out;
    }
    .p-queue-photo-thumb.succeeded {
      border: 2px solid var(--p-ok, #2e7d32);
      opacity: 0.95;
    }
    .p-queue-photo-thumb.failed {
      border: 2px solid var(--p-danger, #d32f2f);
      opacity: 0.7;
    }
    .p-queue-photo-thumb.queued {
      border: 1.5px dashed var(--p-line, #30363d);
      opacity: 0.85;
    }
    .p-queue-photo-status-badge {
      position: absolute;
      bottom: 2px;
      right: 2px;
      font-size: 8.5px;
      font-weight: 800;
      padding: 1px 3px;
      border-radius: 3px;
      text-transform: uppercase;
      pointer-events: none;
      background: rgba(0, 0, 0, 0.7);
      color: #fff;
      line-height: 1;
    }
    .p-queue-photo-status-badge.in_progress {
      background: var(--p-accent, #388bfd);
      color: var(--p-accent-ink, #ffffff);
    }
    .p-queue-photo-status-badge.succeeded {
      background: var(--p-ok, #2e7d32);
    }
    .p-queue-photo-status-badge.failed {
      background: var(--p-danger, #d32f2f);
    }
    .p-queue-photo-status-badge.queued {
      background: rgba(0, 0, 0, 0.6);
      color: var(--p-muted, #8b949e);
    }
    .p-queue-photo-del-btn {
      position: absolute;
      top: -5px;
      right: -5px;
      width: 19px;
      height: 19px;
      border-radius: 50%;
      background: var(--p-danger, #d32f2f);
      color: #fff;
      border: 1.5px solid var(--p-panel, #151b23);
      display: none;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      font-size: 10px;
      font-weight: 700;
      line-height: 1;
      padding: 0;
      z-index: 3;
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
    }
    .p-queue-photo-wrapper:hover .p-queue-photo-del-btn {
      display: flex;
    }
    .p-queue-photo-del-btn:hover {
      transform: scale(1.15);
    }
    .p-queue-photos-more {
      font-size: 11px;
      color: var(--p-muted, #8b949e);
      padding: 4px 6px;
      grid-column: 1 / -1;
      text-align: center;
    }
  `;

  class QueueWidget {
    constructor() {
      this.expanded = false;
      this.items = [];
      this.status = null;
      this.photosCache = new Map();
      this.expandedPhotos = new Set();
      this.expandedActiveRunPhotos = true;
      this.activePhotoFilter = 'all';
      this.activePhotoEls = new Map();
      this.editingId = null;
      this.editTitleValue = '';
      this.pollInterval = null;

      this.initStyles();
      this.initDom();
      this.bindEvents();
      this.refresh();
      this.startPolling();
    }

    initStyles() {
      if (document.getElementById('p-queue-widget-styles')) return;
      const style = document.createElement('style');
      style.id = 'p-queue-widget-styles';
      style.textContent = STYLES;
      document.head.appendChild(style);
    }

    initDom() {
      this.container = document.createElement('div');
      this.container.id = 'pQueueWidgetContainer';

      // 1. Floating Action Button (created once)
      this.fab = document.createElement('button');
      this.fab.className = 'p-queue-fab';
      this.fab.type = 'button';
      this.fab.title = 'View enrichment queue';
      this.fab.innerHTML = `
        <span class="p-queue-pulse-dot" style="display: none;"></span>
        <span class="p-queue-fab-label">Queue</span>
        <span class="p-queue-badge p-queue-fab-badge">0</span>
      `;
      this.fabPulse = this.fab.querySelector('.p-queue-pulse-dot');
      this.fabLabel = this.fab.querySelector('.p-queue-fab-label');
      this.fabBadge = this.fab.querySelector('.p-queue-fab-badge');
      this.fab.addEventListener('click', () => this.toggleExpand());
      this.container.appendChild(this.fab);

      // 2. Backdrop Overlay (created once)
      this.backdrop = document.createElement('div');
      this.backdrop.className = 'p-queue-backdrop';
      this.backdrop.addEventListener('click', () => this.toggleExpand(false));
      this.container.appendChild(this.backdrop);

      // 3. Slide-over Panel (created once)
      this.panel = document.createElement('div');
      this.panel.className = 'p-queue-panel';

      // Header
      this.head = document.createElement('div');
      this.head.className = 'p-queue-head';
      this.head.innerHTML = `
        <div class="title-wrap">
          <span class="p-queue-pulse-dot" style="display: none;"></span>
          <span>Enrichment Queue</span>
          <span class="p-queue-badge p-queue-head-badge">0</span>
        </div>
        <div class="grow"></div>
        <div class="p-queue-head-actions">
          <button class="p-btn accent p-queue-runall-btn" style="height: 26px; padding: 0 8px; font-size: 11.5px; display: none;">Run all</button>
          <button class="p-queue-btn-icon p-queue-clear-btn" title="Clear all queued items" style="font-size: 11.5px; display: none;">Clear</button>
          <button class="p-queue-btn-icon p-queue-close-btn" title="Close sidebar" style="font-size: 16px; padding: 2px 6px;">✕</button>
        </div>
      `;
      this.headPulse = this.head.querySelector('.p-queue-pulse-dot');
      this.headBadge = this.head.querySelector('.p-queue-head-badge');
      this.runAllBtn = this.head.querySelector('.p-queue-runall-btn');
      this.clearBtn = this.head.querySelector('.p-queue-clear-btn');
      this.closeBtn = this.head.querySelector('.p-queue-close-btn');

      this.closeBtn.addEventListener('click', () => this.toggleExpand(false));
      this.clearBtn.addEventListener('click', () => this.clearAll());
      this.runAllBtn.addEventListener('click', () => this.runAll());
      this.panel.appendChild(this.head);

      // Body (scrollable container)
      this.body = document.createElement('div');
      this.body.className = 'p-queue-body';

      // Sub-containers inside body
      this.activeRunContainer = document.createElement('div');
      this.activeRunContainer.className = 'p-queue-active-run-wrap';

      this.queuedContainer = document.createElement('div');
      this.queuedContainer.className = 'p-queue-items-wrap';

      this.emptyNotice = document.createElement('div');
      this.emptyNotice.className = 'p-queue-empty';
      this.emptyNotice.innerHTML = 'The enrichment queue is empty.<br><br>In Insights, browse any photo cluster or sweep and click "Send to Enrich".';

      this.body.append(this.activeRunContainer, this.queuedContainer, this.emptyNotice);
      this.panel.appendChild(this.body);

      this.container.appendChild(this.panel);
      document.body.appendChild(this.container);
    }

    bindEvents() {
      window.addEventListener('enrich-queue-changed', () => this.refresh());
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') this.refresh();
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && this.expanded && !this.editingId) {
          this.toggleExpand(false);
        }
      });
    }

    startPolling() {
      if (this.pollInterval) clearInterval(this.pollInterval);
      this.pollInterval = setInterval(() => {
        const isBusy = this.status?.running || this.status?.resolvingSlice;
        this.refreshStatus();
        if (isBusy || this.expanded) {
          this.refreshQueue();
        }
      }, 2500);
    }

    async refresh() {
      await Promise.all([this.refreshQueue(), this.refreshStatus()]);
    }

    async refreshQueue() {
      try {
        const res = await fetch('/api/enrich/queue?limit=100');
        if (!res.ok) return;
        const data = await res.json();
        this.items = data.items || [];
        this.updateView();
      } catch {
        // Silently tolerate transient errors
      }
    }

    async refreshStatus() {
      try {
        const res = await fetch('/api/enrich/status');
        if (!res.ok) return;
        this.status = await res.json();
        this.updateView();
      } catch {
        // Silently tolerate transient errors
      }
    }

    toggleExpand(forcedState) {
      this.expanded = typeof forcedState === 'boolean' ? forcedState : !this.expanded;
      if (this.expanded) {
        this.backdrop.classList.add('open');
        this.panel.classList.add('open');
        this.refresh();
      } else {
        this.backdrop.classList.remove('open');
        this.panel.classList.remove('open');
      }
    }

    fmtWhen(iso) {
      if (!iso) return '';
      const d = new Date(iso);
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
        + ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    }

    async reorderItem(index, direction) {
      const targetIndex = index + direction;
      if (targetIndex < 0 || targetIndex >= this.items.length) return;
      const reordered = [...this.items];
      const temp = reordered[index];
      reordered[index] = reordered[targetIndex];
      reordered[targetIndex] = temp;

      this.items = reordered;
      this.renderQueuedItems();

      try {
        const res = await fetch('/api/enrich/queue/reorder', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: reordered.map((it) => it.id) }),
        });
        if (res.ok) {
          const data = await res.json();
          this.items = data.items || reordered;
          this.renderQueuedItems();
          window.dispatchEvent(new CustomEvent('enrich-queue-changed'));
        }
      } catch {
        this.refreshQueue();
      }
    }

    async saveTitle(id, newTitle) {
      const title = newTitle.trim();
      this.editingId = null;
      if (!title) {
        this.renderQueuedItems();
        return;
      }
      try {
        const res = await fetch(`/api/enrich/queue/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title }),
        });
        if (res.ok) {
          const data = await res.json();
          const item = this.items.find((it) => it.id === id);
          if (item && data.item) Object.assign(item, data.item);
          this.renderQueuedItems();
          window.dispatchEvent(new CustomEvent('enrich-queue-changed'));
        }
      } catch {
        this.refreshQueue();
      }
    }

    async deleteItem(id) {
      try {
        const res = await fetch(`/api/enrich/queue/${id}`, { method: 'DELETE' });
        if (res.ok) {
          this.items = this.items.filter((it) => it.id !== id);
          this.updateView();
          window.dispatchEvent(new CustomEvent('enrich-queue-changed'));
        } else {
          const err = await res.json().catch(() => null);
          alert(err?.error?.message || 'Could not remove item');
        }
      } catch {
        this.refreshQueue();
      }
    }

    async deleteActivePhoto(assetId, wrapEl) {
      try {
        const res = await fetch(`/api/enrich/active/photos/${encodeURIComponent(assetId)}`, { method: 'DELETE' });
        if (res.ok) {
          if (wrapEl) wrapEl.remove();
          this.activePhotoEls.delete(assetId);
          if (Array.isArray(this.status?.activePhotos)) {
            this.status.activePhotos = this.status.activePhotos.filter((p) => p.id !== assetId);
          }
          this.updateView();
          window.dispatchEvent(new CustomEvent('enrich-queue-changed'));
        } else {
          const err = await res.json().catch(() => null);
          alert(err?.error?.message || 'Could not remove photo from active run');
        }
      } catch (err) {
        alert(err.message || 'Failed to remove photo');
      }
    }

    async cancelCurrentRun() {
      if (!confirm('Stop the ongoing enrichment run?')) return;
      try {
        const res = await fetch('/api/enrich/cancel', { method: 'POST' });
        if (res.ok) {
          await this.refresh();
          window.dispatchEvent(new CustomEvent('enrich-queue-changed'));
        }
      } catch (err) {
        alert(err.message || 'Could not stop run');
      }
    }

    async clearAll() {
      if (!confirm('Clear all queued slices?')) return;
      try {
        const res = await fetch('/api/enrich/queue', { method: 'DELETE' });
        if (res.ok) {
          this.items = [];
          this.updateView();
          window.dispatchEvent(new CustomEvent('enrich-queue-changed'));
        }
      } catch {
        this.refreshQueue();
      }
    }

    async runItem(id, sendToCurate, reopenDecided) {
      const item = this.items.find((it) => it.id === id);
      if (!item) return;
      try {
        const providerEl = document.getElementById('enrichProvider');
        const provider = providerEl ? providerEl.value : undefined;
        const res = await fetch(`/api/enrich/queue/${id}/run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider,
            sendToCurate,
            reopenDecided,
            skipAnySuccessful: !reopenDecided,
          }),
        });
        if (res.ok) {
          const body = await res.json();
          await this.refresh();
          window.dispatchEvent(new CustomEvent('enrich-queue-changed'));
          if (typeof window.toast === 'function') {
            window.toast(body.queuedRemaining
              ? 'Run started (capped at 1,000 photos needing work)'
              : 'Run started');
          }
        } else {
          const err = await res.json().catch(() => null);
          alert(err?.error?.message || 'Could not start run');
        }
      } catch (err) {
        alert(err.message || 'Run failed');
      }
    }

    async runAll() {
      const plan = this.items.map((it) => {
        const cardEl = this.queuedContainer.querySelector(`.p-queue-card[data-qid="${it.id}"]`);
        const sendCheck = cardEl?.querySelector('.p-queue-send-curate')?.checked !== false;
        const reopenCheck = cardEl?.querySelector('.p-queue-reopen')?.checked === true;
        return { id: it.id, sendToCurate: sendCheck, reopenDecided: reopenCheck };
      });
      if (plan.length === 0) return;

      try {
        const providerEl = document.getElementById('enrichProvider');
        const provider = providerEl ? providerEl.value : undefined;
        const res = await fetch('/api/enrich/queue/run-all', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider, plan }),
        });
        if (res.ok) {
          const body = await res.json();
          await this.refresh();
          window.dispatchEvent(new CustomEvent('enrich-queue-changed'));
          if (typeof window.toast === 'function') {
            window.toast(`Running ${body.planned || plan.length} job(s) in order`);
          }
        } else {
          const err = await res.json().catch(() => null);
          alert(err?.error?.message || 'Could not start queue run');
        }
      } catch (err) {
        alert(err.message || 'Run all failed');
      }
    }

    async togglePhotos(id) {
      if (this.expandedPhotos.has(id)) {
        this.expandedPhotos.delete(id);
        this.renderQueuedItems();
        return;
      }
      this.expandedPhotos.add(id);
      this.renderQueuedItems();

      if (!this.photosCache.has(id)) {
        this.photosCache.set(id, { loading: true, assets: [], total: 0 });
        this.renderQueuedItems();
        try {
          const res = await fetch(`/api/enrich/queue/${id}/photos`);
          if (res.ok) {
            const data = await res.json();
            this.photosCache.set(id, { loading: false, assets: data.assets || [], total: data.total || 0 });
          } else {
            this.photosCache.set(id, { loading: false, assets: [], total: 0, error: true });
          }
        } catch {
          this.photosCache.set(id, { loading: false, assets: [], total: 0, error: true });
        }
        this.renderQueuedItems();
      }
    }

    updateView() {
      const isRunning = Boolean(this.status?.running);
      const count = this.items.length;

      // Update FAB in-place
      this.fabPulse.style.display = isRunning ? 'inline-block' : 'none';
      this.fabLabel.textContent = isRunning ? 'Active run' : 'Queue';
      this.fabBadge.textContent = count;

      // Update Header in-place
      this.headPulse.style.display = isRunning ? 'inline-block' : 'none';
      this.headBadge.textContent = count;
      this.runAllBtn.style.display = count >= 2 ? 'inline-block' : 'none';
      this.clearBtn.style.display = count > 0 ? 'inline-block' : 'none';

      // Update Active Run Card
      this.renderActiveRun();

      // Update Queued Items List
      this.renderQueuedItems();

      // Empty state
      this.emptyNotice.style.display = (count === 0 && !isRunning) ? 'block' : 'none';
    }

    renderActiveRun() {
      const isRunning = Boolean(this.status?.running);
      if (!isRunning) {
        this.activeRunContainer.innerHTML = '';
        this.activePhotoEls.clear();
        return;
      }

      const analyzed = this.status?.counters?.analyzed ?? 0;
      const maxAnalyzed = this.status?.options?.maxAnalyzed;
      const targetCount = this.status?.options?.targeted || (maxAnalyzed ? `${maxAnalyzed} max` : '');
      const progressStr = targetCount ? `${analyzed} / ${targetCount} photos` : `${analyzed} photos analyzed`;
      const runTitle = this.status?.title || 'Enrichment run in progress';
      const providerName = this.status?.provider ? ` · ${this.status.provider}` : '';
      const modeLabel = this.status?.options?.reprocess
        ? 'Refresh all'
        : (this.status?.options?.skipAnySuccessful ? 'Only unenriched' : '');

      let percent = 0;
      const totalTarget = typeof targetCount === 'number' ? targetCount : (parseInt(targetCount, 10) || 0);
      if (totalTarget > 0) {
        percent = Math.min(100, Math.round((analyzed / totalTarget) * 100));
      }

      const activePhotos = Array.isArray(this.status?.activePhotos) ? this.status.activePhotos : [];
      const currentAssetId = this.status?.currentAssetId;

      let countQueued = 0;
      let countInProgress = 0;
      let countSucceeded = 0;
      let countFailed = 0;
      activePhotos.forEach((p) => {
        const isCurrent = p.id === currentAssetId || p.status === 'in_progress';
        if (isCurrent) countInProgress++;
        else if (p.status === 'succeeded') countSucceeded++;
        else if (p.status === 'failed') countFailed++;
        else countQueued++;
      });

      let card = this.activeRunContainer.querySelector('.p-queue-card.running');
      if (!card) {
        card = document.createElement('div');
        card.className = 'p-queue-card running';
        card.innerHTML = `
          <div class="p-queue-card-top">
            <span class="p-queue-pulse-dot" style="margin-right: 4px;"></span>
            <div class="p-queue-title-area">
              <span class="p-queue-title-text p-active-title" style="color: var(--p-ink); font-weight: 700;"></span>
            </div>
            <span class="p-chip" style="font-size: 10.5px; padding: 2px 7px; background: var(--p-accent); color: var(--p-accent-ink); font-weight: 700;">Running</span>
            <button class="p-btn quiet p-queue-stop-btn" type="button" style="height: 22px; padding: 0 6px; font-size: 11px; color: var(--p-danger, #d32f2f);" title="Stop ongoing run">Stop</button>
          </div>
          <div class="p-queue-meta-row">
            <span class="p-active-progress"></span>
            <span class="p-active-mode" style="font-size: 11px;"></span>
          </div>
          <div class="p-queue-progress-bar-wrap" style="display: none;">
            <div class="p-queue-progress-bar-fill"></div>
          </div>
          <div class="p-queue-meta-row p-active-photos-head" style="margin-top: 6px; display: none;">
            <span class="p-active-count-label" style="font-weight: 600;"></span>
            <button class="p-queue-photos-toggle p-active-toggle-btn" type="button">▲ Hide</button>
          </div>
          <div class="p-queue-filter-pills p-active-filter-bar" style="display: none;"></div>
          <div class="p-queue-active-grid p-active-grid" style="display: none;"></div>
        `;

        card.querySelector('.p-queue-stop-btn')?.addEventListener('click', () => this.cancelCurrentRun());
        card.querySelector('.p-active-toggle-btn')?.addEventListener('click', () => {
          this.expandedActiveRunPhotos = !this.expandedActiveRunPhotos;
          this.updateActivePhotosVisibility(card);
        });

        this.activeRunContainer.appendChild(card);
      }

      // Update text in place
      card.querySelector('.p-active-title').textContent = runTitle;
      card.querySelector('.p-active-progress').textContent = `${progressStr}${providerName}`;
      const modeEl = card.querySelector('.p-active-mode');
      modeEl.textContent = modeLabel;
      modeEl.style.display = modeLabel ? 'inline' : 'none';

      const progressWrap = card.querySelector('.p-queue-progress-bar-wrap');
      const progressFill = card.querySelector('.p-queue-progress-bar-fill');
      if (totalTarget > 0) {
        progressWrap.style.display = 'block';
        progressWrap.title = `${percent}% complete`;
        progressFill.style.width = `${percent}%`;
      } else {
        progressWrap.style.display = 'none';
      }

      const photosHead = card.querySelector('.p-active-photos-head');
      const countLabel = card.querySelector('.p-active-count-label');
      const filterBar = card.querySelector('.p-active-filter-bar');
      const grid = card.querySelector('.p-active-grid');

      if (activePhotos.length > 0) {
        photosHead.style.display = 'flex';
        countLabel.textContent = `All photos in run (${activePhotos.length})`;
        this.updateActivePhotosVisibility(card);

        // Update filter pills
        filterBar.innerHTML = '';
        const filters = [
          { id: 'all', label: `All (${activePhotos.length})` },
          { id: 'queued', label: `Queued (${countQueued})` },
          { id: 'in_progress', label: `Analyzing (${countInProgress})` },
          { id: 'succeeded', label: `Done (${countSucceeded})` },
          { id: 'failed', label: `Failed (${countFailed})` },
        ];
        filters.forEach((f) => {
          const pill = document.createElement('button');
          pill.type = 'button';
          pill.className = `p-queue-filter-pill${this.activePhotoFilter === f.id ? ' active' : ''}`;
          pill.textContent = f.label;
          pill.addEventListener('click', () => {
            this.activePhotoFilter = f.id;
            this.applyPhotoFilter(grid, activePhotos, currentAssetId);
            this.renderActiveRun();
          });
          filterBar.appendChild(pill);
        });

        // Update photo elements in-place
        const seenIds = new Set();
        activePhotos.forEach((photo) => {
          seenIds.add(photo.id);
          const isCurrent = photo.id === currentAssetId || photo.status === 'in_progress';
          const status = isCurrent ? 'in_progress' : (photo.status || 'queued');
          const isQueued = status === 'queued';

          let wrap = this.activePhotoEls.get(photo.id);
          if (!wrap) {
            wrap = document.createElement('div');
            wrap.className = 'p-queue-photo-wrapper';
            wrap.dataset.pid = photo.id;

            const img = document.createElement('img');
            img.className = `p-queue-photo-thumb ${status}`;
            img.src = `/api/review/thumbnail/${encodeURIComponent(photo.id)}`;
            img.loading = 'lazy';
            img.onerror = () => { img.style.opacity = '0.35'; };

            const badge = document.createElement('span');
            badge.className = `p-queue-photo-status-badge ${status}`;

            const delBtn = document.createElement('button');
            delBtn.className = 'p-queue-photo-del-btn';
            delBtn.type = 'button';
            delBtn.textContent = '✕';
            delBtn.title = 'Remove photo from ongoing run';
            delBtn.addEventListener('click', async (e) => {
              e.stopPropagation();
              delBtn.disabled = true;
              await this.deleteActivePhoto(photo.id, wrap);
            });

            wrap.append(img, badge, delBtn);
            this.activePhotoEls.set(photo.id, wrap);
            grid.appendChild(wrap);
          }

          // Update attributes in-place without rebuilding DOM
          const img = wrap.querySelector('.p-queue-photo-thumb');
          if (img) {
            img.className = `p-queue-photo-thumb ${status}`;
            img.title = `Photo ${photo.id} (${status})${isQueued ? ' — click ✕ to remove' : ''}`;
          }

          const badge = wrap.querySelector('.p-queue-photo-status-badge');
          if (badge) {
            badge.className = `p-queue-photo-status-badge ${status}`;
            badge.textContent = status === 'in_progress' ? 'now' : (status === 'succeeded' ? '✓' : (status === 'failed' ? '✗' : 'wait'));
          }

          const delBtn = wrap.querySelector('.p-queue-photo-del-btn');
          if (delBtn) {
            delBtn.style.display = isQueued ? '' : 'none';
          }
        });

        // Remove elements for photos no longer in the list
        for (const [id, wrap] of this.activePhotoEls.entries()) {
          if (!seenIds.has(id)) {
            wrap.remove();
            this.activePhotoEls.delete(id);
          }
        }

        this.applyPhotoFilter(grid, activePhotos, currentAssetId);
      } else {
        photosHead.style.display = 'none';
        filterBar.style.display = 'none';
        grid.style.display = 'none';
      }
    }

    updateActivePhotosVisibility(card) {
      const toggleBtn = card.querySelector('.p-active-toggle-btn');
      const filterBar = card.querySelector('.p-active-filter-bar');
      const grid = card.querySelector('.p-active-grid');
      if (toggleBtn) toggleBtn.textContent = this.expandedActiveRunPhotos ? '▲ Hide' : '📷 Show';
      if (filterBar) filterBar.style.display = this.expandedActiveRunPhotos ? 'flex' : 'none';
      if (grid) grid.style.display = this.expandedActiveRunPhotos ? 'grid' : 'none';
    }

    applyPhotoFilter(grid, activePhotos, currentAssetId) {
      for (const photo of activePhotos) {
        const wrap = this.activePhotoEls.get(photo.id);
        if (!wrap) continue;
        const isCurrent = photo.id === currentAssetId || photo.status === 'in_progress';
        const st = isCurrent ? 'in_progress' : (photo.status || 'queued');

        let show = true;
        if (this.activePhotoFilter === 'queued') show = (st === 'queued');
        else if (this.activePhotoFilter === 'in_progress') show = (st === 'in_progress');
        else if (this.activePhotoFilter === 'succeeded') show = (st === 'succeeded');
        else if (this.activePhotoFilter === 'failed') show = (st === 'failed');

        wrap.classList.toggle('hidden', !show);
      }
    }

    renderQueuedItems() {
      const count = this.items.length;
      if (count === 0) {
        this.queuedContainer.innerHTML = '';
        return;
      }

      // Preserve body scroll position across item renders
      const prevScroll = this.body.scrollTop;

      const isRunning = Boolean(this.status?.running);
      const runningQueueId = isRunning ? Number(this.status?.options?.queueItemId) : null;

      const listHeader = document.createElement('div');
      listHeader.style.cssText = 'font-size: 12px; font-weight: 700; color: var(--p-muted); text-transform: uppercase; letter-spacing: 0.5px; padding-top: 4px;';
      listHeader.textContent = isRunning ? 'Upcoming jobs' : 'Queued jobs';

      const cardsFragment = document.createDocumentFragment();
      cardsFragment.appendChild(listHeader);

      this.items.forEach((item, index) => {
        const isItemRunning = isRunning && runningQueueId === item.id;
        const card = document.createElement('div');
        card.className = `p-queue-card${isItemRunning ? ' running' : ''}`;
        card.dataset.qid = String(item.id);

        const top = document.createElement('div');
        top.className = 'p-queue-card-top';

        const reorderGroup = document.createElement('div');
        reorderGroup.className = 'p-queue-reorder-group';
        const upBtn = document.createElement('button');
        upBtn.className = 'p-queue-reorder-btn';
        upBtn.type = 'button';
        upBtn.innerHTML = '▲';
        upBtn.title = 'Move up in queue';
        upBtn.disabled = index === 0 || isRunning;
        upBtn.addEventListener('click', () => this.reorderItem(index, -1));

        const downBtn = document.createElement('button');
        downBtn.className = 'p-queue-reorder-btn';
        downBtn.type = 'button';
        downBtn.innerHTML = '▼';
        downBtn.title = 'Move down in queue';
        downBtn.disabled = index === this.items.length - 1 || isRunning;
        downBtn.addEventListener('click', () => this.reorderItem(index, 1));
        reorderGroup.append(upBtn, downBtn);

        const titleArea = document.createElement('div');
        titleArea.className = 'p-queue-title-area';

        if (this.editingId === item.id) {
          const input = document.createElement('input');
          input.className = 'p-queue-title-input';
          input.type = 'text';
          input.value = this.editTitleValue;
          input.maxLength = 120;
          const save = () => this.saveTitle(item.id, input.value);
          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') save();
            if (e.key === 'Escape') {
              this.editingId = null;
              this.renderQueuedItems();
            }
          });
          input.addEventListener('blur', save);
          titleArea.appendChild(input);
          setTimeout(() => { input.focus(); input.select(); }, 10);
        } else {
          const titleSpan = document.createElement('span');
          titleSpan.className = 'p-queue-title-text';
          titleSpan.textContent = item.title;
          titleSpan.title = `${item.title} (click to edit)`;
          titleSpan.style.cursor = 'pointer';
          titleSpan.addEventListener('click', () => {
            this.editingId = item.id;
            this.editTitleValue = item.title;
            this.renderQueuedItems();
          });

          const editBtn = document.createElement('button');
          editBtn.className = 'p-queue-edit-btn';
          editBtn.type = 'button';
          editBtn.innerHTML = '✎';
          editBtn.title = 'Edit title';
          editBtn.addEventListener('click', () => {
            this.editingId = item.id;
            this.editTitleValue = item.title;
            this.renderQueuedItems();
          });

          titleArea.append(titleSpan, editBtn);
        }

        const actions = document.createElement('div');
        actions.className = 'p-queue-actions';

        const runBtn = document.createElement('button');
        runBtn.className = 'p-btn accent';
        runBtn.style.cssText = 'height: 24px; padding: 0 9px; font-size: 11.5px;';
        runBtn.textContent = isItemRunning ? 'Running…' : 'Run';
        runBtn.disabled = isRunning;

        const removeBtn = document.createElement('button');
        removeBtn.className = 'p-btn quiet';
        removeBtn.style.cssText = 'height: 24px; padding: 0 7px; font-size: 11.5px;';
        removeBtn.textContent = '✕';
        removeBtn.title = 'Remove slice';
        removeBtn.disabled = isItemRunning;
        removeBtn.addEventListener('click', () => this.deleteItem(item.id));

        actions.append(runBtn, removeBtn);
        top.append(reorderGroup, titleArea, actions);

        const metaRow = document.createElement('div');
        metaRow.className = 'p-queue-meta-row';

        const metaText = document.createElement('span');
        metaText.textContent = `${item.estimatedCount != null ? `~${Number(item.estimatedCount).toLocaleString()} photos · ` : ''}queued ${this.fmtWhen(item.requestedAt)}`;

        const isPhotosOpen = this.expandedPhotos.has(item.id);
        const photosToggleBtn = document.createElement('button');
        photosToggleBtn.className = 'p-queue-photos-toggle';
        photosToggleBtn.type = 'button';
        photosToggleBtn.innerHTML = isPhotosOpen ? '▲ Hide photos' : '📷 Photos';
        photosToggleBtn.addEventListener('click', () => this.togglePhotos(item.id));

        metaRow.append(metaText, photosToggleBtn);

        const optionsRow = document.createElement('div');
        optionsRow.className = 'p-queue-options-row';

        const sendLabel = document.createElement('label');
        const sendCheck = document.createElement('input');
        sendCheck.type = 'checkbox';
        sendCheck.className = 'p-queue-send-curate';
        sendCheck.checked = true;
        sendLabel.append(sendCheck, 'Curate');

        const reopenLabel = document.createElement('label');
        const reopenCheck = document.createElement('input');
        reopenCheck.type = 'checkbox';
        reopenCheck.className = 'p-queue-reopen';
        reopenCheck.checked = false;
        reopenLabel.append(reopenCheck, 'incl. curated');

        sendCheck.addEventListener('change', () => {
          reopenCheck.disabled = !sendCheck.checked;
          if (!sendCheck.checked) reopenCheck.checked = false;
          reopenLabel.style.opacity = sendCheck.checked ? '1' : '0.45';
        });

        runBtn.addEventListener('click', () => {
          this.runItem(item.id, sendCheck.checked, reopenCheck.checked);
        });

        optionsRow.append(sendLabel, reopenLabel);

        card.append(top, metaRow, optionsRow);

        if (isPhotosOpen) {
          const previewBox = document.createElement('div');
          previewBox.style.cssText = 'border-top: 1px solid var(--p-line); padding-top: 6px; margin-top: 2px;';

          const cache = this.photosCache.get(item.id);
          if (!cache || cache.loading) {
            previewBox.innerHTML = '<span class="p-muted" style="font-size: 11.5px;">Loading photo previews…</span>';
          } else if (cache.error || cache.assets.length === 0) {
            previewBox.innerHTML = '<span class="p-muted" style="font-size: 11.5px;">No photo previews available</span>';
          } else {
            const grid = document.createElement('div');
            grid.className = 'p-queue-active-grid';
            grid.style.maxHeight = '240px';

            cache.assets.forEach((asset) => {
              const wrap = document.createElement('div');
              wrap.className = 'p-queue-photo-wrapper';

              const img = document.createElement('img');
              img.className = 'p-queue-photo-thumb';
              img.src = `/api/review/thumbnail/${encodeURIComponent(asset.id)}`;
              img.loading = 'lazy';
              img.alt = asset.originalPath || 'Photo';
              img.title = asset.originalPath || asset.id;
              img.onerror = () => { img.style.opacity = '0.35'; };

              const delBtn = document.createElement('button');
              delBtn.className = 'p-queue-photo-del-btn';
              delBtn.type = 'button';
              delBtn.textContent = '✕';
              delBtn.title = 'Remove photo from queue';
              delBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                delBtn.disabled = true;
                try {
                  const res = await fetch(`/api/enrich/queue/${item.id}/photos/${encodeURIComponent(asset.id)}`, { method: 'DELETE' });
                  if (res.ok) {
                    wrap.remove();
                    cache.assets = cache.assets.filter((a) => a.id !== asset.id);
                    cache.total = Math.max(0, cache.total - 1);
                    if (typeof item.estimatedCount === 'number') {
                      item.estimatedCount = Math.max(0, item.estimatedCount - 1);
                    }
                    await this.refreshQueue();
                    window.dispatchEvent(new CustomEvent('enrich-queue-changed'));
                  }
                } catch {
                  // Ignore transient errors
                }
              });

              wrap.append(img, delBtn);
              grid.appendChild(wrap);
            });

            if (cache.total > cache.assets.length) {
              const more = document.createElement('div');
              more.className = 'p-queue-photos-more';
              more.textContent = `+${cache.total - cache.assets.length} more photos`;
              grid.appendChild(more);
            }
            previewBox.appendChild(grid);
          }
          card.appendChild(previewBox);
        }

        cardsFragment.appendChild(card);
      });

      this.queuedContainer.replaceChildren(cardsFragment);
      this.body.scrollTop = prevScroll;
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      window.PictariaQueue = new QueueWidget();
    });
  } else {
    window.PictariaQueue = new QueueWidget();
  }
})();
