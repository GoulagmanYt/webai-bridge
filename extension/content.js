/**
 * WebAI Bridge - Unified Content Script Entrypoint (v2.4.0)
 * Orchestrates modular sub-systems:
 *   - content-providers.js (Gemini, Claude, ChatGPT, DeepSeek hash-free, AI Studio)
 *   - content-upload.js (Formal UploadStateMachine: IDLE -> VALIDATING -> PREPARING -> INJECTING -> VERIFYING_DOM -> READY | FAILED)
 *   - content-core.js (Authenticated WebSocket client, STREAM_CHUNK anti-timeout emitter, DOM execution)
 *   - Obsidian Signal Shadow-DOM Floating Status Pill
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    const providers = require('./content-providers.js');
    const upload = require('./content-upload.js');
    const core = require('./content-core.js');
    module.exports = factory(providers, upload, core);
  } else {
    root.WebAIBridge = factory(
      root.WebAIBridgeProviders,
      root.WebAIBridgeUpload,
      root.WebAIBridgeCore
    );
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Providers, Upload, Core) {
  'use strict';

  if (!Providers || !Upload || !Core) {
    throw new Error('WebAI Bridge content modules failed to initialize');
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const PILL_HOST_ID = 'webai-bridge-pill-host';
  const PILL_POS_STORAGE_KEY = 'webai_bridge_pill_pos';
  const PILL_DEFAULT_WIDTH = 156;
  const PILL_DEFAULT_HEIGHT = 32;
  const PILL_MARGIN = 10;

  const NON_BUSY_UPLOAD_STATES = new Set(['IDLE', 'READY', 'FAILED', 'ROLLED_BACK']);

  let activeRuntime = null;
  let activePill = null;

  /**
   * Backward compatibility & diagnostic helper for doctor.mjs.
   * Utilizes the formal state machine: new DataTransfer() and ClipboardEvent('paste') vectors.
   * @param {Array<object>} files
   * @param {object} [provider]
   * @returns {Promise<object>}
   */
  async function uploadAttachmentsToDOM(files, provider) {
    const p = provider || Providers.detectProvider();
    const sm = new Upload.UploadStateMachine();
    return sm.executeUpload(files, p);
  }

  /**
   * Maps a runtime status summary into a canonical Obsidian Signal pill state & label.
   * @param {object|null|undefined} summary
   * @returns {{ state: string, label: string, dedicated: boolean, busy: boolean, connected: boolean }}
   */
  function resolvePillState(summary) {
    const s = summary && typeof summary === 'object' ? summary : {};
    const dedicated = s.dedicated !== false;
    const busy = Boolean(s.busy || s.isBusy || s.activeRequestId || s.activeJobId);
    const connected = Boolean(s.connected);
    const connecting = Boolean(s.connecting);
    const wasReplaced = Boolean(s.wasReplaced);
    const uploadState = typeof s.uploadState === 'string' ? s.uploadState : 'IDLE';

    if (busy) {
      const uploading = !NON_BUSY_UPLOAD_STATES.has(uploadState);
      return {
        state: 'busy',
        label: uploading ? 'Bridge \u00b7 Upload' : 'Bridge \u00b7 Busy',
        dedicated,
        busy: true,
        connected
      };
    }
    if (wasReplaced) {
      return { state: 'replaced', label: 'Bridge \u00b7 Replaced', dedicated, busy: false, connected };
    }
    if (!dedicated) {
      return { state: 'standby', label: 'Bridge \u00b7 Standby', dedicated: false, busy: false, connected: false };
    }
    if (connected) {
      return { state: 'connected', label: 'Bridge \u00b7 Live', dedicated: true, busy: false, connected: true };
    }
    if (connecting) {
      return { state: 'connecting', label: 'Bridge \u00b7 Connecting', dedicated: true, busy: false, connected: false };
    }
    if (s.lastError) {
      return { state: 'error', label: 'Bridge \u00b7 Offline', dedicated: true, busy: false, connected: false };
    }
    return { state: 'disconnected', label: 'Bridge \u00b7 Offline', dedicated: true, busy: false, connected: false };
  }

  /**
   * Clamps floating pill coordinates safely within the active browser viewport.
   * @param {number} x
   * @param {number} y
   * @param {number} [width=156]
   * @param {number} [height=32]
   * @param {number} [viewportW=1280]
   * @param {number} [viewportH=800]
   * @returns {{ x: number, y: number }}
   */
  function clampPillPosition(
    x,
    y,
    width = PILL_DEFAULT_WIDTH,
    height = PILL_DEFAULT_HEIGHT,
    viewportW = 1280,
    viewportH = 800
  ) {
    const w = Number.isFinite(width) && width > 0 ? width : PILL_DEFAULT_WIDTH;
    const h = Number.isFinite(height) && height > 0 ? height : PILL_DEFAULT_HEIGHT;
    const vw = Number.isFinite(viewportW) && viewportW > 0 ? viewportW : 1280;
    const vh = Number.isFinite(viewportH) && viewportH > 0 ? viewportH : 800;

    const maxX = Math.max(PILL_MARGIN, vw - w - PILL_MARGIN);
    const maxY = Math.max(PILL_MARGIN, vh - h - PILL_MARGIN);

    const clampedX = Math.min(maxX, Math.max(PILL_MARGIN, Number.isFinite(x) ? x : PILL_MARGIN));
    const clampedY = Math.min(maxY, Math.max(PILL_MARGIN, Number.isFinite(y) ? y : PILL_MARGIN));
    return { x: Math.round(clampedX), y: Math.round(clampedY) };
  }

  function isTopLevelFrame() {
    try {
      if (typeof window === 'undefined') return false;
      if (window.top && window.self && window.top !== window.self) {
        return false;
      }
    } catch (_) {
      return false;
    }
    return true;
  }

  function buildGripSvg() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', '8');
    svg.setAttribute('height', '12');
    svg.setAttribute('viewBox', '0 0 8 12');
    svg.setAttribute('fill', 'currentColor');
    svg.setAttribute('aria-hidden', 'true');
    const coords = [
      [2, 2.5], [6, 2.5],
      [2, 6], [6, 6],
      [2, 9.5], [6, 9.5]
    ];
    for (const [cx, cy] of coords) {
      const circle = document.createElementNS(SVG_NS, 'circle');
      circle.setAttribute('cx', String(cx));
      circle.setAttribute('cy', String(cy));
      circle.setAttribute('r', '1.15');
      svg.appendChild(circle);
    }
    return svg;
  }

  function buildPillStyles() {
    return `
      :host {
        all: initial;
        position: fixed;
        z-index: 2147483647;
        top: 10px;
        left: 50%;
        transform: translateX(-50%);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
        font-variant-numeric: tabular-nums;
        -webkit-font-smoothing: antialiased;
      }
      :host([data-positioned="true"]) {
        transform: none;
      }
      .pill-btn {
        all: unset;
        box-sizing: border-box;
        height: 32px;
        padding: 0 11px 0 7px;
        border-radius: 999px;
        display: inline-flex;
        align-items: center;
        gap: 7px;
        cursor: pointer;
        user-select: none;
        background: rgba(13, 17, 24, 0.92);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        border: 1px solid #252e3f;
        color: #eef2f8;
        font-size: 11.5px;
        font-weight: 600;
        line-height: 1;
        letter-spacing: -0.005em;
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.42), inset 0 1px 0 rgba(255, 255, 255, 0.05);
        transition: background-color 0.16s ease, border-color 0.16s ease, color 0.16s ease, box-shadow 0.16s ease;
      }
      .pill-btn:hover {
        background: rgba(20, 26, 37, 0.96);
        border-color: #36435b;
      }
      .pill-btn:focus-visible {
        outline: 2px solid #7c8cf8;
        outline-offset: 2px;
      }
      .pill-btn[data-state="connected"] {
        border-color: rgba(16, 185, 129, 0.42);
        color: #ecfdf5;
      }
      .pill-btn[data-state="busy"] {
        border-color: rgba(245, 158, 11, 0.48);
        color: #fffbeb;
      }
      .pill-btn[data-state="connecting"] {
        border-color: rgba(96, 165, 250, 0.42);
        color: #eff6ff;
      }
      .pill-btn[data-state="standby"] {
        border-color: rgba(148, 163, 184, 0.28);
        color: #cbd5e1;
      }
      .pill-btn[data-state="replaced"],
      .pill-btn[data-state="error"],
      .pill-btn[data-state="disconnected"] {
        border-color: rgba(244, 63, 94, 0.36);
        color: #ffe4e6;
      }
      .grip {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 14px;
        height: 20px;
        border-radius: 999px;
        color: #68758c;
        cursor: grab;
        flex-shrink: 0;
      }
      .grip:hover {
        color: #cbd5e1;
        background: rgba(255, 255, 255, 0.05);
      }
      .grip:active {
        cursor: grabbing;
      }
      .dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: #94a3b8;
        flex-shrink: 0;
      }
      .pill-btn[data-state="connected"] .dot {
        background: #10b981;
        animation: pill-pulse-ok 2.2s ease-out infinite;
      }
      .pill-btn[data-state="busy"] .dot {
        background: #f59e0b;
        animation: pill-pulse-busy 1.3s ease-out infinite;
      }
      .pill-btn[data-state="connecting"] .dot {
        background: #60a5fa;
        animation: pill-pulse-connect 1.5s ease-out infinite;
      }
      .pill-btn[data-state="standby"] .dot {
        background: #94a3b8;
      }
      .pill-btn[data-state="replaced"] .dot,
      .pill-btn[data-state="error"] .dot,
      .pill-btn[data-state="disconnected"] .dot {
        background: #f43f5e;
      }
      .label {
        white-space: nowrap;
      }
      @keyframes pill-pulse-ok {
        0% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.55); }
        70% { box-shadow: 0 0 0 5px rgba(16, 185, 129, 0); }
        100% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
      }
      @keyframes pill-pulse-busy {
        0% { box-shadow: 0 0 0 0 rgba(245, 158, 11, 0.6); }
        70% { box-shadow: 0 0 0 5px rgba(245, 158, 11, 0); }
        100% { box-shadow: 0 0 0 0 rgba(245, 158, 11, 0); }
      }
      @keyframes pill-pulse-connect {
        0% { box-shadow: 0 0 0 0 rgba(96, 165, 250, 0.55); }
        70% { box-shadow: 0 0 0 5px rgba(96, 165, 250, 0); }
        100% { box-shadow: 0 0 0 0 rgba(96, 165, 250, 0); }
      }
      @media (prefers-reduced-motion: reduce) {
        *, *::before, *::after {
          animation: none !important;
          transition: none !important;
        }
      }
    `;
  }

  /**
   * Obsidian Signal Shadow-DOM Floating Status Pill.
   * Allows dragging across the viewport (persisted in localStorage) and clicking to toggle
   * between Dedicated and Standby modes without interrupting an active job.
   */
  class FloatingBridgePill {
    constructor(runtime, options = {}) {
      this.runtime = runtime;
      this.providerName = options.providerName || (runtime && runtime.provider && runtime.provider.name) || 'WebAI';
      this.host = null;
      this.shadow = null;
      this.buttonEl = null;
      this.dotEl = null;
      this.labelEl = null;
      this.observer = null;
      this._suppressNextClick = false;
      this._onPointerMove = null;
      this._onPointerUp = null;
      this._latestSummary = runtime && typeof runtime.getStatusSummary === 'function'
        ? runtime.getStatusSummary()
        : { ok: true, connected: false, dedicated: true, port: 4545 };
      this._onResize = () => this._handleResize();
    }

    mount() {
      if (!isTopLevelFrame() || typeof document === 'undefined') return null;

      let host = document.getElementById(PILL_HOST_ID);
      if (!host) {
        host = document.createElement('div');
        host.id = PILL_HOST_ID;
        host.setAttribute('data-webai-bridge-ui', 'true');
        host.setAttribute('data-watermark', 'WebAI Bridge');
      }
      this.host = host;

      if (!this.shadow && host.shadowRoot) {
        this.shadow = host.shadowRoot;
        this.buttonEl = this.shadow.querySelector('.pill-btn');
        this.dotEl = this.shadow.querySelector('.dot');
        this.labelEl = this.shadow.querySelector('.label');
      }

      if (!this.shadow && typeof host.attachShadow === 'function') {
        this.shadow = host.attachShadow({ mode: 'open' });
        const style = document.createElement('style');
        style.textContent = buildPillStyles();

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'pill-btn';
        btn.setAttribute('data-state', 'disconnected');

        const grip = document.createElement('span');
        grip.className = 'grip';
        grip.title = 'Drag to reposition';
        grip.setAttribute('aria-hidden', 'true');
        grip.appendChild(buildGripSvg());

        const dot = document.createElement('span');
        dot.className = 'dot';
        dot.setAttribute('aria-hidden', 'true');

        const label = document.createElement('span');
        label.className = 'label';
        label.textContent = 'Bridge \u00b7 Offline';

        btn.appendChild(grip);
        btn.appendChild(dot);
        btn.appendChild(label);

        this._bindInteractions(btn, grip);

        this.shadow.appendChild(style);
        this.shadow.appendChild(btn);

        this.buttonEl = btn;
        this.dotEl = dot;
        this.labelEl = label;
      }

      this.ensureMounted();
      this._restorePosition();
      this.update(this._latestSummary);

      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.removeEventListener('resize', this._onResize);
        window.addEventListener('resize', this._onResize);
      }
      this._observeMount();
      return this.host;
    }

    ensureMounted() {
      if (!isTopLevelFrame() || typeof document === 'undefined' || !this.host) return false;
      const root = document.documentElement || document.body;
      if (!root) return false;
      if (!this.host.isConnected) {
        try {
          root.appendChild(this.host);
        } catch (_) {
          return false;
        }
      }
      return true;
    }

    _observeMount() {
      if (this.observer || typeof MutationObserver === 'undefined' || typeof document === 'undefined') return;
      const target = document.documentElement || document.body;
      if (!target) return;
      this.observer = new MutationObserver(() => {
        if (this.host && !this.host.isConnected) {
          this.ensureMounted();
          this.update(this._latestSummary);
        }
      });
      this.observer.observe(target, { childList: true, subtree: false });
    }

    _restorePosition() {
      if (!this.host || typeof window === 'undefined') return;
      try {
        if (typeof localStorage === 'undefined' || !localStorage || typeof localStorage.getItem !== 'function') {
          return;
        }
        const raw = localStorage.getItem(PILL_POS_STORAGE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed.x !== 'number' || typeof parsed.y !== 'number') return;

        const rect = this.host.getBoundingClientRect ? this.host.getBoundingClientRect() : null;
        const vw = window.innerWidth || 1280;
        const vh = window.innerHeight || 800;
        const clamped = clampPillPosition(
          parsed.x,
          parsed.y,
          (rect && rect.width) || PILL_DEFAULT_WIDTH,
          (rect && rect.height) || PILL_DEFAULT_HEIGHT,
          vw,
          vh
        );
        this.host.style.left = `${clamped.x}px`;
        this.host.style.top = `${clamped.y}px`;
        this.host.style.right = 'auto';
        this.host.style.bottom = 'auto';
        this.host.setAttribute('data-positioned', 'true');
      } catch (_) {}
    }

    _savePosition(x, y) {
      try {
        if (typeof localStorage !== 'undefined' && localStorage && typeof localStorage.setItem === 'function') {
          localStorage.setItem(PILL_POS_STORAGE_KEY, JSON.stringify({ x, y }));
        }
      } catch (_) {}
    }

    _handleResize() {
      if (!this.host || this.host.getAttribute('data-positioned') !== 'true' || typeof window === 'undefined') {
        return;
      }
      const curLeft = parseFloat(this.host.style.left);
      const curTop = parseFloat(this.host.style.top);
      if (!Number.isFinite(curLeft) || !Number.isFinite(curTop)) return;
      const rect = this.host.getBoundingClientRect ? this.host.getBoundingClientRect() : null;
      const clamped = clampPillPosition(
        curLeft,
        curTop,
        (rect && rect.width) || PILL_DEFAULT_WIDTH,
        (rect && rect.height) || PILL_DEFAULT_HEIGHT,
        window.innerWidth || 1280,
        window.innerHeight || 800
      );
      this.host.style.left = `${clamped.x}px`;
      this.host.style.top = `${clamped.y}px`;
      this._savePosition(clamped.x, clamped.y);
    }

    _bindInteractions(btn, grip) {
      let dragging = false;
      let movedPastThreshold = false;
      let startClientX = 0;
      let startClientY = 0;
      let originX = 0;
      let originY = 0;

      const getCurrentOrigin = () => {
        const rect = this.host && this.host.getBoundingClientRect ? this.host.getBoundingClientRect() : null;
        if (rect && (rect.left > 0 || rect.top > 0)) {
          return { x: rect.left, y: rect.top };
        }
        const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280;
        return {
          x: Math.round((vw - ((rect && rect.width) || PILL_DEFAULT_WIDTH)) / 2),
          y: PILL_MARGIN
        };
      };

      const onPointerDown = (evt) => {
        if (evt.button !== undefined && evt.button !== 0) return;
        const isGripTarget = evt.target === grip || (grip && typeof grip.contains === 'function' && grip.contains(evt.target));
        const isSpaceDrag = evt.altKey;
        if (!isGripTarget && !isSpaceDrag) return;

        const origin = getCurrentOrigin();
        dragging = true;
        movedPastThreshold = false;
        startClientX = evt.clientX;
        startClientY = evt.clientY;
        originX = origin.x;
        originY = origin.y;

        if (this.host) {
          this.host.style.left = `${originX}px`;
          this.host.style.top = `${originY}px`;
          this.host.style.right = 'auto';
          this.host.style.bottom = 'auto';
          this.host.setAttribute('data-positioned', 'true');
        }
      };

      const onPointerMove = (evt) => {
        if (!dragging || !this.host || typeof window === 'undefined') return;
        const dx = evt.clientX - startClientX;
        const dy = evt.clientY - startClientY;
        if (!movedPastThreshold && Math.hypot(dx, dy) > 5) {
          movedPastThreshold = true;
        }
        if (!movedPastThreshold) return;

        const rect = this.host.getBoundingClientRect ? this.host.getBoundingClientRect() : null;
        const clamped = clampPillPosition(
          originX + dx,
          originY + dy,
          (rect && rect.width) || PILL_DEFAULT_WIDTH,
          (rect && rect.height) || PILL_DEFAULT_HEIGHT,
          window.innerWidth || 1280,
          window.innerHeight || 800
        );
        this.host.style.left = `${clamped.x}px`;
        this.host.style.top = `${clamped.y}px`;
      };

      const finishDrag = () => {
        if (!dragging) return;
        dragging = false;
        if (movedPastThreshold && this.host) {
          this._suppressNextClick = true;
          const x = parseFloat(this.host.style.left) || PILL_MARGIN;
          const y = parseFloat(this.host.style.top) || PILL_MARGIN;
          this._savePosition(x, y);
        }
        movedPastThreshold = false;
      };

      this._onPointerMove = onPointerMove;
      this._onPointerUp = finishDrag;

      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', finishDrag);
        window.addEventListener('pointercancel', finishDrag);
      }

      btn.addEventListener('pointerdown', onPointerDown);

      btn.addEventListener('click', () => {
        if (this._suppressNextClick) {
          this._suppressNextClick = false;
          return;
        }
        if (!this.runtime) return;
        const info = resolvePillState(this._latestSummary);
        if (info.busy) return;

        if (info.connected && info.dedicated) {
          if (typeof this.runtime.setDedicated === 'function') {
            this.runtime.setDedicated(false).catch(() => {});
          }
        } else if (typeof this.runtime.setDedicated === 'function') {
          this.runtime.setDedicated(true).catch(() => {});
        } else if (typeof this.runtime.reconfigure === 'function') {
          this.runtime.reconfigure(this.runtime.port, this.runtime.authToken).catch(() => {});
        }
      });
    }

    update(summary) {
      this._latestSummary = summary || this._latestSummary;
      if (!this.buttonEl || !this.labelEl) return;

      const info = resolvePillState(this._latestSummary);
      const port = (this._latestSummary && this._latestSummary.port) || (this.runtime && this.runtime.port) || 4545;

      this.buttonEl.setAttribute('data-state', info.state);
      this.buttonEl.setAttribute('data-dedicated', String(info.dedicated));
      this.buttonEl.setAttribute('aria-busy', String(info.busy));
      this.labelEl.textContent = info.label;

      const actionHint = info.busy
        ? 'Task in progress'
        : (info.connected && info.dedicated
            ? 'Click to switch tab to Standby'
            : 'Click to dedicate tab to WebAI Bridge');
      const titleText = `WebAI Bridge \u00b7 ${this.providerName} (:${port}) \u2014 ${info.label}. ${actionHint}`;
      this.buttonEl.title = titleText;
      this.buttonEl.setAttribute('aria-label', titleText);
    }

    destroy() {
      if (this.observer) {
        this.observer.disconnect();
        this.observer = null;
      }
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('resize', this._onResize);
        if (this._onPointerMove) {
          window.removeEventListener('pointermove', this._onPointerMove);
        }
        if (this._onPointerUp) {
          window.removeEventListener('pointerup', this._onPointerUp);
          window.removeEventListener('pointercancel', this._onPointerUp);
        }
      }
      this._onPointerMove = null;
      this._onPointerUp = null;
      if (this.host && typeof this.host.remove === 'function') {
        this.host.remove();
      }
      this.host = null;
      this.shadow = null;
      this.buttonEl = null;
      this.dotEl = null;
      this.labelEl = null;
    }
  }

  /**
   * Boots the content script runtime inside a supported Web AI tab, mounts the
   * Obsidian Signal Floating Pill, and binds Chrome extension messaging.
   * @returns {object|null}
   */
  function initContentBridge() {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return null;
    }

    if (window.__WEBAI_BRIDGE_INITIALIZED__ && activeRuntime) {
      if (activePill) activePill.ensureMounted();
      return activeRuntime;
    }

    const provider = Providers.detectProvider(window.location.hostname);
    if (!provider) {
      return null;
    }

    window.__WEBAI_BRIDGE_INITIALIZED__ = true;
    activeRuntime = new Core.BridgeContentRuntime({ provider });

    activePill = new FloatingBridgePill(activeRuntime, { providerName: provider.name });
    activePill.mount();

    activeRuntime.onStateChange((summary) => {
      if (activePill) {
        activePill.update(summary);
      }
    });

    activeRuntime.connect();

    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (!message || typeof message !== 'object') return false;

        if (message.type === 'WEBAI_GET_TAB_STATUS') {
          const base = typeof activeRuntime.getStatusSummary === 'function'
            ? activeRuntime.getStatusSummary()
            : {
                ok: true,
                provider: provider.id,
                providerName: provider.name,
                connected: Boolean(activeRuntime.ws && activeRuntime.ws.readyState === 1),
                dedicated: Boolean(activeRuntime.dedicated !== false),
                wasReplaced: Boolean(activeRuntime.wasReplaced),
                port: activeRuntime.port,
                busy: activeRuntime.isBusy,
                activeRequestId: activeRuntime.activeRequestId,
                uploadState: activeRuntime.uploadMachine.state,
                debugMode: activeRuntime.debugMode,
                logCount: (activeRuntime.debugLogs || []).length
              };
          sendResponse(base);
          return true;
        }

        if (message.type === 'WEBAI_SET_DEDICATED') {
          const nextDedicated = Boolean(message.dedicated);
          if (typeof activeRuntime.setDedicated === 'function') {
            activeRuntime.setDedicated(nextDedicated)
              .then(() => sendResponse({ ok: true, dedicated: activeRuntime.dedicated, status: activeRuntime.getStatusSummary() }))
              .catch((err) => sendResponse({ ok: false, error: err.message }));
            return true;
          }
          sendResponse({ ok: false, error: 'setDedicated not supported' });
          return true;
        }

        if (message.type === 'WEBAI_SET_DEBUG_MODE') {
          const enabled = message.debugMode !== undefined ? message.debugMode : message.enabled;
          activeRuntime.setDebugMode(enabled);
          sendResponse({ ok: true, debugMode: activeRuntime.debugMode });
          return true;
        }

        if (message.type === 'WEBAI_GET_DEBUG_LOGS') {
          sendResponse({ ok: true, logs: activeRuntime.getDebugLogs(message.limit || 100) });
          return true;
        }

        if (message.type === 'WEBAI_CLEAR_DEBUG_LOGS') {
          activeRuntime.clearDebugLogs();
          sendResponse({ ok: true });
          return true;
        }

        if (message.type === 'WEBAI_RECONFIGURE_BRIDGE') {
          activeRuntime
            .reconfigure(message.port, message.authToken)
            .then(() => {
              sendResponse({ ok: true, port: activeRuntime.port });
            })
            .catch((err) => {
              sendResponse({ ok: false, error: err.message });
            });
          return true;
        }

        return false;
      });
    }

    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local' || !activeRuntime) return;
        const newPort = changes.bridgePort ? changes.bridgePort.newValue : activeRuntime.port;
        const newToken = changes.bridgeAuthToken ? changes.bridgeAuthToken.newValue : activeRuntime.authToken;
        if (changes.bridgePort || changes.bridgeAuthToken) {
          if (activeRuntime.dedicated) {
            activeRuntime.reconfigure(newPort, newToken).catch(() => {});
          } else {
            if (newPort) activeRuntime.port = Number(newPort) || Core.DEFAULT_BRIDGE_PORT;
            if (typeof newToken === 'string') activeRuntime.authToken = newToken.trim();
            if (typeof activeRuntime._emitStateChange === 'function') {
              activeRuntime._emitStateChange();
            }
          }
        }
        if (changes.debugMode) {
          activeRuntime.setDebugMode(changes.debugMode.newValue);
        }
      });
    }

    return activeRuntime;
  }

  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initContentBridge, { once: true });
    } else {
      initContentBridge();
    }
  }

  return {
    PROVIDERS: Providers.PROVIDERS,
    detectProvider: Providers.detectProvider,
    findInputElement: Providers.findInputElement,
    findSendButton: Providers.findSendButton,
    isProviderStreaming: Providers.isProviderStreaming,
    extractCleanResponse: Providers.extractCleanResponse,
    getLatestResponseSnapshot: Providers.getLatestResponseSnapshot,
    UPLOAD_STATES: Upload.UPLOAD_STATES,
    ALLOWED_TRANSITIONS: Upload.ALLOWED_TRANSITIONS,
    UploadStateMachine: Upload.UploadStateMachine,
    uploadAttachmentsToDOM,
    sanitizeFileName: Upload.sanitizeFileName,
    buildFileObject: Upload.buildFileObject,
    resolveComposerContainer: Upload.resolveComposerContainer,
    filesMatchBatch: Upload.filesMatchBatch,
    DEFAULT_BRIDGE_PORT: Core.DEFAULT_BRIDGE_PORT,
    FILE_UPLOAD_THRESHOLD: Core.FILE_UPLOAD_THRESHOLD,
    DEFAULT_STARTUP_TIMEOUT_MS: Core.DEFAULT_STARTUP_TIMEOUT_MS,
    prepareLargePromptPayload: Core.prepareLargePromptPayload,
    buildWebSocketUrl: Core.buildWebSocketUrl,
    injectPromptText: Core.injectPromptText,
    triggerSend: Core.triggerSend,
    captureStreamingResponse: Core.captureStreamingResponse,
    collectTabDiagnostics: Core.collectTabDiagnostics,
    BridgeContentRuntime: Core.BridgeContentRuntime,
    resolvePillState,
    clampPillPosition,
    FloatingBridgePill,
    initContentBridge
  };
});
