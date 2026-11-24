/**
 * WebAI Bridge - Formal File Upload State Machine
 * Enforces deterministic transitions, payload validation, multi-strategy DOM injection,
 * and post-injection attachment chip verification before prompt dispatch.
 * Dual-environment module: Browser Content Script (window) & Node.js (CommonJS).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    const providersMod = require('./content-providers.js');
    module.exports = factory(providersMod);
  } else {
    root.WebAIBridgeUpload = factory(root.WebAIBridgeProviders);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Providers) {
  'use strict';

  const UPLOAD_STATES = Object.freeze({
    IDLE: 'IDLE',
    VALIDATING: 'VALIDATING',
    PREPARING: 'PREPARING',
    INJECTING: 'INJECTING',
    VERIFYING_DOM: 'VERIFYING_DOM',
    READY: 'READY',
    FAILED: 'FAILED',
    ROLLED_BACK: 'ROLLED_BACK'
  });

  const ALLOWED_TRANSITIONS = Object.freeze({
    [UPLOAD_STATES.IDLE]: [UPLOAD_STATES.VALIDATING, UPLOAD_STATES.READY],
    [UPLOAD_STATES.VALIDATING]: [UPLOAD_STATES.PREPARING, UPLOAD_STATES.FAILED],
    [UPLOAD_STATES.PREPARING]: [UPLOAD_STATES.INJECTING, UPLOAD_STATES.FAILED],
    [UPLOAD_STATES.INJECTING]: [UPLOAD_STATES.VERIFYING_DOM, UPLOAD_STATES.FAILED],
    [UPLOAD_STATES.VERIFYING_DOM]: [
      UPLOAD_STATES.READY,
      UPLOAD_STATES.INJECTING, // Retry transition
      UPLOAD_STATES.FAILED
    ],
    [UPLOAD_STATES.READY]: [UPLOAD_STATES.IDLE],
    [UPLOAD_STATES.FAILED]: [UPLOAD_STATES.ROLLED_BACK, UPLOAD_STATES.IDLE, UPLOAD_STATES.PREPARING],
    [UPLOAD_STATES.ROLLED_BACK]: [UPLOAD_STATES.IDLE]
  });

  const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB per file
  const DEFAULT_LAZY_INPUT_TIMEOUT_MS = 1000;
  const DEFAULT_LAZY_INPUT_POLL_MS = 100;
  const DEFAULT_CHIP_SETTLE_MS = 200;

  const MESSAGE_HISTORY_SELECTOR =
    'user-query, .user-query-container, .user-query, [data-test-id*="user-query"], ' +
    '[data-message-author-role="user"], [data-testid="user-message"], ' +
    'model-response, [data-message-author-role="assistant"], [data-testid="assistant-message"]';

  const COMPOSER_CONTAINER_SELECTOR =
    '.input-area-container, .initial-input-area-container, .initial-input-area, ' +
    '.chat-input-container, form, fieldset, [class*="composer"], ' +
    '[class*="inputWrapper"], [class*="inputFullContainer"], [class*="input-area"], ' +
    '[class*="chat-input"], [role="region"]';

  /**
   * Sleeps for a specified duration in ms.
   * @param {number} ms
   * @returns {Promise<void>}
   */
  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Sanitizes a filename to prevent path traversal or control characters in the DOM.
   * @param {string} name
   * @returns {string}
   */
  function sanitizeFileName(name) {
    if (!name || typeof name !== 'string') return 'attachment.txt';
    const base = name.split(/[\\/]/).pop() || 'attachment.txt';
    const cleaned = base.replace(/[\x00-\x1f\x80-\x9f<>:"|?*]/g, '_').trim();
    return cleaned || 'attachment.txt';
  }

  /**
   * Checks whether an element belongs to an already-sent chat message in conversation history.
   * @param {Element|null} el
   * @returns {boolean}
   */
  function isInsideMessageHistory(el) {
    if (!el || typeof el.closest !== 'function') return false;
    try {
      return Boolean(el.closest(MESSAGE_HISTORY_SELECTOR));
    } catch (_) {
      return false;
    }
  }

  /**
   * Resolves the composer container around the active input element without ever matching
   * the input element itself or falling back to document.body / document.documentElement.
   * @param {object} provider
   * @returns {Element|null}
   */
  function resolveComposerContainer(provider) {
    if (typeof document === 'undefined') return null;
    const inputEl = Providers && provider ? Providers.findInputElement(provider) : null;
    const isDocumentRoot = (el) => !el || el === document.body || el === document.documentElement;

    if (inputEl && inputEl.parentElement) {
      if (typeof inputEl.parentElement.closest === 'function') {
        try {
          const matched = inputEl.parentElement.closest(COMPOSER_CONTAINER_SELECTOR);
          if (matched && !isDocumentRoot(matched)) {
            return matched;
          }
        } catch (_) {}
      }
      if (!isDocumentRoot(inputEl.parentElement)) {
        return inputEl.parentElement;
      }
    }

    try {
      const form = document.querySelector('form');
      if (form && !isDocumentRoot(form)) {
        return form;
      }
    } catch (_) {}

    return null;
  }

  /**
   * Collects deduplicated elements matching any selector in `selectors` under `rootNode`,
   * optionally excluding elements nested inside chat message history.
   * @param {string[]} selectors
   * @param {ParentNode|null} rootNode
   * @param {object} [options]
   * @returns {Element[]}
   */
  function collectMatchingElements(selectors, rootNode, options = {}) {
    if (!rootNode || typeof rootNode.querySelectorAll !== 'function' || !Array.isArray(selectors)) {
      return [];
    }
    const requireVisible = Boolean(options.requireVisible);
    const excludeHistory = options.excludeHistory !== false;
    const seen = new Set();
    const results = [];

    for (const selector of selectors) {
      if (!selector || typeof selector !== 'string') continue;
      let nodes;
      try {
        nodes = rootNode.querySelectorAll(selector);
      } catch (_) {
        continue;
      }
      for (const node of nodes) {
        if (seen.has(node)) continue;
        if (excludeHistory && isInsideMessageHistory(node)) continue;
        if (requireVisible && Providers && typeof Providers.isVisibleElement === 'function' && !Providers.isVisibleElement(node)) {
          continue;
        }
        seen.add(node);
        results.push(node);
      }
    }
    return results;
  }

  /**
   * Checks whether an <input type="file">'s FileList exactly matches the target fileObjects batch.
   * @param {FileList|Array|null} existingFiles
   * @param {Array<File|object>} targetFiles
   * @returns {boolean}
   */
  function filesMatchBatch(existingFiles, targetFiles) {
    if (!existingFiles || !Array.isArray(targetFiles)) return false;
    if (existingFiles.length !== targetFiles.length || targetFiles.length === 0) return false;
    for (let i = 0; i < targetFiles.length; i++) {
      const existing = existingFiles[i];
      const target = targetFiles[i];
      if (!existing || !target) return false;
      if (existing.name !== target.name) return false;
      if (typeof existing.size === 'number' && typeof target.size === 'number' && existing.size !== target.size) {
        return false;
      }
    }
    return true;
  }

  /**
   * Converts a file descriptor ({ name, content, encoding, mimeType }) into a browser File object.
   * @param {object} desc
   * @returns {File|object}
   */
  function buildFileObject(desc) {
    const safeName = sanitizeFileName(desc.name || desc.path || 'attachment.txt');
    const mimeType = desc.mimeType || desc.type || 'text/plain;charset=utf-8';
    let byteArray;

    if (desc.encoding === 'base64' && typeof desc.content === 'string') {
      if (typeof atob === 'function') {
        const binaryString = atob(desc.content);
        byteArray = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          byteArray[i] = binaryString.charCodeAt(i);
        }
      } else if (typeof Buffer !== 'undefined') {
        byteArray = new Uint8Array(Buffer.from(desc.content, 'base64'));
      }
    } else {
      const textContent = typeof desc.content === 'string' ? desc.content : JSON.stringify(desc.content ?? '');
      if (typeof TextEncoder !== 'undefined') {
        byteArray = new TextEncoder().encode(textContent);
      } else if (typeof Buffer !== 'undefined') {
        byteArray = new Uint8Array(Buffer.from(textContent, 'utf8'));
      } else {
        byteArray = new Uint8Array(0);
      }
    }

    if (typeof File === 'function') {
      return new File([byteArray], safeName, {
        type: mimeType,
        lastModified: Date.now()
      });
    }

    // Node.js test fallback object when global File is unavailable
    return {
      name: safeName,
      size: byteArray.byteLength,
      type: mimeType,
      _bytes: byteArray
    };
  }

  /**
   * Formal Upload State Machine.
   */
  class UploadStateMachine {
    /**
     * @param {object} [options]
     * @param {number} [options.maxFileBytes]
     * @param {number} [options.maxRetries]
     * @param {number} [options.verifyTimeoutMs]
     * @param {number} [options.lazyInputTimeoutMs]
     * @param {number} [options.lazyInputPollMs]
     * @param {number} [options.chipSettleMs]
     * @param {Function} [options.onTransition]
     */
    constructor(options = {}) {
      this.state = UPLOAD_STATES.IDLE;
      this.maxFileBytes = options.maxFileBytes || DEFAULT_MAX_FILE_BYTES;
      this.maxRetries = typeof options.maxRetries === 'number' ? options.maxRetries : 2;
      this.verifyTimeoutMs = options.verifyTimeoutMs || 8000;
      this.lazyInputTimeoutMs =
        typeof options.lazyInputTimeoutMs === 'number' ? options.lazyInputTimeoutMs : DEFAULT_LAZY_INPUT_TIMEOUT_MS;
      this.lazyInputPollMs =
        typeof options.lazyInputPollMs === 'number' ? options.lazyInputPollMs : DEFAULT_LAZY_INPUT_POLL_MS;
      this.chipSettleMs =
        typeof options.chipSettleMs === 'number' ? options.chipSettleMs : DEFAULT_CHIP_SETTLE_MS;
      this.onTransition = typeof options.onTransition === 'function' ? options.onTransition : null;
      this.history = [
        {
          from: null,
          to: UPLOAD_STATES.IDLE,
          timestamp: Date.now(),
          meta: { reason: 'init' }
        }
      ];
      this.lastError = null;
    }

    /**
     * Performs a validated state transition.
     * @param {string} nextState
     * @param {object} [meta]
     * @returns {string}
     */
    transition(nextState, meta = {}) {
      const allowed = ALLOWED_TRANSITIONS[this.state] || [];
      if (!allowed.includes(nextState)) {
        const err = new Error(
          `Illegal upload state transition: ${this.state} -> ${nextState}`
        );
        err.code = 'ERR_INVALID_UPLOAD_TRANSITION';
        err.fromState = this.state;
        err.toState = nextState;
        throw err;
      }

      const prevState = this.state;
      this.state = nextState;
      const entry = {
        from: prevState,
        to: nextState,
        timestamp: Date.now(),
        meta
      };
      this.history.push(entry);

      if (this.onTransition) {
        try {
          this.onTransition(entry);
        } catch (_) {
          // Observer errors must not break the state machine
        }
      }
      return this.state;
    }

    /**
     * Resets the state machine back to IDLE.
     */
    reset() {
      if (this.state === UPLOAD_STATES.FAILED) {
        this.transition(UPLOAD_STATES.ROLLED_BACK, { reason: 'cleanup_before_reset' });
      }
      if (this.state !== UPLOAD_STATES.IDLE) {
        this.transition(UPLOAD_STATES.IDLE, { reason: 'reset' });
      }
      this.lastError = null;
    }

    /**
     * Returns a shallow copy of the transition history.
     * @returns {Array<object>}
     */
    getHistory() {
      return this.history.slice();
    }

    /**
     * Captures pre-injection DOM attachment chips and composer text to prevent false positives
     * from earlier turns or leftover attachments.
     * @param {object} provider
     * @returns {{ composerRoot: Element|null, existingChips: Set<Element>, baselineComposerText: string }}
     */
    captureBaseline(provider) {
      if (typeof document === 'undefined') {
        return { composerRoot: null, existingChips: new Set(), baselineComposerText: '' };
      }
      const composerRoot = resolveComposerContainer(provider);
      const chipSelectors = (provider && provider.attachmentChipSelectors) || [];
      const searchRoot = composerRoot || document;
      const chips = collectMatchingElements(chipSelectors, searchRoot, {
        requireVisible: false,
        excludeHistory: true
      });
      const baselineComposerText = composerRoot
        ? (composerRoot.innerText || composerRoot.textContent || '')
        : '';
      return {
        composerRoot,
        existingChips: new Set(chips),
        baselineComposerText
      };
    }

    /**
     * Validates an array of file descriptors before preparing File objects.
     * @param {Array<object>} files
     * @returns {Array<object>}
     */
    validatePayloads(files) {
      this.transition(UPLOAD_STATES.VALIDATING, { count: Array.isArray(files) ? files.length : 0 });

      if (!Array.isArray(files) || files.length === 0) {
        const err = new Error('Upload payload must be a non-empty array of files');
        err.code = 'ERR_UPLOAD_EMPTY_PAYLOAD';
        this.lastError = err;
        this.transition(UPLOAD_STATES.FAILED, { code: err.code, message: err.message });
        throw err;
      }

      const normalized = [];
      for (let i = 0; i < files.length; i++) {
        const item = files[i];
        if (!item || typeof item !== 'object') {
          const err = new Error(`Invalid file descriptor at index ${i}`);
          err.code = 'ERR_UPLOAD_INVALID_DESCRIPTOR';
          this.lastError = err;
          this.transition(UPLOAD_STATES.FAILED, { code: err.code, index: i });
          throw err;
        }

        const rawContent = typeof item.content === 'string' ? item.content : '';
        const estimatedBytes =
          item.encoding === 'base64'
            ? Math.floor((rawContent.length * 3) / 4)
            : rawContent.length;

        if (estimatedBytes > this.maxFileBytes) {
          const err = new Error(
            `File "${item.name || i}" exceeds maximum size (${estimatedBytes} > ${this.maxFileBytes} bytes)`
          );
          err.code = 'ERR_UPLOAD_FILE_TOO_LARGE';
          this.lastError = err;
          this.transition(UPLOAD_STATES.FAILED, { code: err.code, name: item.name });
          throw err;
        }

        normalized.push({
          name: sanitizeFileName(item.name || item.path || `file_${i + 1}.txt`),
          content: rawContent,
          encoding: item.encoding === 'base64' ? 'base64' : 'utf8',
          mimeType: item.mimeType || item.type || 'text/plain;charset=utf-8'
        });
      }

      return normalized;
    }

    /**
     * Prepares browser File objects from validated descriptors.
     * @param {Array<object>} normalizedDescriptors
     * @returns {Array<File|object>}
     */
    prepareFiles(normalizedDescriptors) {
      this.transition(UPLOAD_STATES.PREPARING, { count: normalizedDescriptors.length });
      try {
        return normalizedDescriptors.map((desc) => buildFileObject(desc));
      } catch (err) {
        err.code = err.code || 'ERR_UPLOAD_PREPARE_FAILED';
        this.lastError = err;
        this.transition(UPLOAD_STATES.FAILED, { code: err.code, message: err.message });
        throw err;
      }
    }

    /**
     * Injects prepared File objects into the active provider DOM using a 3-tier strategy:
     * 1. Existing <input type="file"> via DataTransfer (cleared on attempt 1; compared on retry)
     * 2. Clicking the upload trigger button and polling for a lazily mounted <input type="file">
     * 3. Synthetic ClipboardEvent('paste') and DragEvent('drop') on the chat composer input
     * @param {Array<File|object>} fileObjects
     * @param {object} provider
     * @param {object} [hooks] - Optional test/runtime hooks
     * @returns {Promise<{ strategy: string }>}
     */
    async injectIntoDOM(fileObjects, provider, hooks = {}) {
      const attempt = typeof hooks.attempt === 'number' ? hooks.attempt : 1;
      const lastStrategy = hooks.lastStrategy || 'none';
      const logger = typeof hooks.logger === 'function' ? hooks.logger : ((_c, _l, _m, _d) => {});

      this.transition(UPLOAD_STATES.INJECTING, {
        provider: provider ? provider.id : 'unknown',
        count: fileObjects.length,
        attempt
      });

      if (typeof hooks.injectFn === 'function') {
        try {
          const res = await hooks.injectFn(fileObjects, provider);
          return { strategy: (res && res.strategy) || 'custom_hook' };
        } catch (err) {
          err.code = err.code || 'ERR_UPLOAD_INJECT_FAILED';
          this.lastError = err;
          this.transition(UPLOAD_STATES.FAILED, { code: err.code, message: err.message });
          throw err;
        }
      }

      if (typeof document === 'undefined') {
        const err = new Error('DOM document is not available for file injection');
        err.code = 'ERR_UPLOAD_NO_DOM';
        this.lastError = err;
        this.transition(UPLOAD_STATES.FAILED, { code: err.code });
        throw err;
      }

      const fileInputSelectors = (provider && provider.fileInputSelectors) || ['input[type="file"]'];
      const findFileInput = () => {
        if (Providers && typeof Providers.queryFirst === 'function') {
          const matched = Providers.queryFirst(fileInputSelectors, { requireVisible: false });
          if (matched) return matched;
        }
        return typeof document.querySelector === 'function' ? document.querySelector('input[type="file"]') : null;
      };

      // Helper to clear stale value and populate an <input type="file">
      const tryInputFileElement = (inputEl) => {
        if (!inputEl || typeof DataTransfer !== 'function') return false;
        try {
          inputEl.value = '';
        } catch (_) {
          // Some browsers/mocks restrict setting value
        }
        const dt = new DataTransfer();
        for (const f of fileObjects) {
          dt.items.add(f);
        }
        inputEl.files = dt.files;
        if (typeof inputEl.dispatchEvent === 'function' && typeof Event === 'function') {
          inputEl.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
          inputEl.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        }
        return true;
      };

      // Tier 1: Direct <input type="file"> present in DOM
      let fileInput = findFileInput();

      // Only preserve existing input.files on retry attempts when the batch matches identically
      if (fileInput && attempt > 1 && filesMatchBatch(fileInput.files, fileObjects)) {
        logger('UPLOAD', 'debug', 'Tier 1 retry preserved identical matching batch on input[type="file"]');
        return { strategy: 'direct_file_input_preserved' };
      }

      if (fileInput && tryInputFileElement(fileInput)) {
        logger('UPLOAD', 'info', 'Tier 1 injected files into direct input[type="file"]', { count: fileObjects.length });
        return { strategy: 'direct_file_input' };
      }

      // Tier 2: Click upload trigger button to lazily mount <input type="file"> and poll briefly
      let triggerBtn =
        Providers && provider && provider.uploadTriggerSelectors
          ? Providers.queryFirst(provider.uploadTriggerSelectors, { requireVisible: true })
          : null;

      if (!triggerBtn && provider && provider.customResolver && typeof provider.customResolver.findUploadTrigger === 'function') {
        const inputEl = Providers ? Providers.findInputElement(provider) : null;
        triggerBtn = provider.customResolver.findUploadTrigger(inputEl);
      }

      if (triggerBtn && typeof triggerBtn.click === 'function') {
        logger('UPLOAD', 'debug', 'Tier 2 clicking upload trigger button to reveal lazy file input');
        try {
          triggerBtn.click();
        } catch (_) {}

        const pollDeadline = Date.now() + this.lazyInputTimeoutMs;
        while (true) {
          fileInput = findFileInput();
          if (fileInput && tryInputFileElement(fileInput)) {
            logger('UPLOAD', 'info', 'Tier 2 injected files into lazily mounted input[type="file"]', { count: fileObjects.length });
            return { strategy: 'lazy_file_input' };
          }
          if (Date.now() >= pollDeadline) break;
          await delay(this.lazyInputPollMs);
        }
      }

      // Tier 3: Synthetic ClipboardEvent('paste') and DragEvent('drop') on the chat composer input
      const editorEl = (Providers && provider ? Providers.findInputElement(provider) : null) || document.activeElement;
      if (editorEl && typeof DataTransfer === 'function') {
        const buildDataTransfer = () => {
          const dt = new DataTransfer();
          for (const f of fileObjects) {
            dt.items.add(f);
          }
          return dt;
        };

        const shouldPreferDrop =
          attempt > 1 &&
          lastStrategy === 'clipboard_paste' &&
          typeof DragEvent === 'function';

        if (!shouldPreferDrop && typeof ClipboardEvent === 'function') {
          try {
            const dt = buildDataTransfer();
            if (typeof editorEl.focus === 'function') editorEl.focus();
            const pasteEvent = new ClipboardEvent('paste', {
              bubbles: true,
              cancelable: true,
              composed: true,
              clipboardData: dt
            });
            if (!pasteEvent.clipboardData || !pasteEvent.clipboardData.files || pasteEvent.clipboardData.files.length === 0) {
              try {
                Object.defineProperty(pasteEvent, 'clipboardData', { value: dt });
              } catch (_) {}
            }
            editorEl.dispatchEvent(pasteEvent);
            logger('UPLOAD', 'info', 'Tier 3 dispatched synthetic ClipboardEvent(paste)', { count: fileObjects.length });
            return { strategy: 'clipboard_paste' };
          } catch (_) {
            // Fall through to DragEvent('drop')
          }
        }

        if (typeof DragEvent === 'function') {
          try {
            const dt = buildDataTransfer();
            const dropTarget = resolveComposerContainer(provider) || editorEl;
            for (const eventName of ['dragenter', 'dragover', 'drop']) {
              const dragEvent = new DragEvent(eventName, {
                bubbles: true,
                cancelable: true,
                composed: true,
                dataTransfer: dt
              });
              if (!dragEvent.dataTransfer || !dragEvent.dataTransfer.files || dragEvent.dataTransfer.files.length === 0) {
                try {
                  Object.defineProperty(dragEvent, 'dataTransfer', { value: dt });
                } catch (_) {}
              }
              dropTarget.dispatchEvent(dragEvent);
            }
            logger('UPLOAD', 'info', 'Tier 3 dispatched synthetic DragEvent(drop)', { count: fileObjects.length });
            return { strategy: 'drag_drop' };
          } catch (_) {
            // Fall through to error
          }
        }
      }

      const err = new Error(`Unable to locate an upload target for provider "${provider ? provider.id : 'unknown'}"`);
      err.code = 'ERR_UPLOAD_TARGET_NOT_FOUND';
      this.lastError = err;
      this.transition(UPLOAD_STATES.FAILED, { code: err.code });
      throw err;
    }

    /**
     * Verifies that newly uploaded files have been registered in the composer DOM
     * (ignoring pre-existing chips from earlier turns) and that any upload spinner has finished.
     * @param {object} provider
     * @param {number} expectedCount
     * @param {object} [hooks]
     * @param {Array<File|object>} [fileObjects]
     * @param {object|null} [baseline]
     * @returns {Promise<boolean>}
     */
    async verifyDOMAttachment(provider, expectedCount, hooks = {}, fileObjects = [], baseline = null) {
      const logger = typeof hooks.logger === 'function' ? hooks.logger : ((_c, _l, _m, _d) => {});
      this.transition(UPLOAD_STATES.VERIFYING_DOM, { expectedCount });

      if (typeof hooks.verifyFn === 'function') {
        const ok = await hooks.verifyFn(provider, expectedCount);
        if (ok) {
          this.transition(UPLOAD_STATES.READY, { verifiedCount: expectedCount });
          return true;
        }
        return false;
      }

      if (typeof document === 'undefined') {
        this.transition(UPLOAD_STATES.READY, { verifiedCount: expectedCount, mode: 'headless' });
        return true;
      }

      const chipSelectors = (provider && provider.attachmentChipSelectors) || [];
      const busySelectors = (provider && provider.uploadBusySelectors) || [];
      const existingChips = baseline && baseline.existingChips instanceof Set ? baseline.existingChips : new Set();
      const baselineComposerText = baseline && typeof baseline.baselineComposerText === 'string'
        ? baseline.baselineComposerText
        : '';

      const isUploadBusy = (composerRoot) => {
        if (busySelectors.length === 0) return false;
        const root = composerRoot || document;
        return collectMatchingElements(busySelectors, root, {
          requireVisible: true,
          excludeHistory: true
        }).length > 0;
      };

      const deadline = Date.now() + this.verifyTimeoutMs;
      let firstPartialChipAt = null;

      while (Date.now() < deadline) {
        const composerRoot = resolveComposerContainer(provider) || (baseline && baseline.composerRoot) || null;
        const isBusy = isUploadBusy(composerRoot);

        if (!isBusy) {
          if (chipSelectors.length === 0) {
            await delay(Math.max(this.chipSettleMs, 250));
            if (!isUploadBusy(composerRoot)) {
              this.transition(UPLOAD_STATES.READY, { verifiedCount: expectedCount, mode: 'timer_fallback' });
              return true;
            }
          } else {
            const searchRoot = composerRoot || document;
            const currentChips = collectMatchingElements(chipSelectors, searchRoot, {
              requireVisible: false,
              excludeHistory: true
            });
            const newChips = currentChips.filter((el) => !existingChips.has(el));

            // 1. All expected new attachment chips appeared
            if (newChips.length >= expectedCount) {
              if (this.chipSettleMs > 0) {
                await delay(this.chipSettleMs);
              }
              if (!isUploadBusy(composerRoot)) {
                logger('UPLOAD', 'info', `Verified ${newChips.length} new attachment chip(s) in DOM`, { expectedCount });
                this.transition(UPLOAD_STATES.READY, { verifiedCount: newChips.length, mode: 'dom_chip_delta' });
                return true;
              }
              continue;
            }

            // 2. Partial new chips (e.g. provider collapses multi-file preview) stabilized without busy spinner
            if (newChips.length > 0) {
              if (firstPartialChipAt === null) {
                firstPartialChipAt = Date.now();
              } else if (Date.now() - firstPartialChipAt >= 600) {
                logger('UPLOAD', 'info', `Verified ${newChips.length} stabilized attachment chip(s) in DOM`, { expectedCount });
                this.transition(UPLOAD_STATES.READY, { verifiedCount: newChips.length, mode: 'dom_chip_partial' });
                return true;
              }
            }

            // 3. Strictly composer-scoped file name match (never document.body!)
            if (composerRoot && Array.isArray(fileObjects) && fileObjects.length > 0) {
              const composerText = composerRoot.innerText || composerRoot.textContent || '';
              if (composerText && composerText !== baselineComposerText) {
                const newlyMatchedNames = fileObjects.filter(
                  (f) => f && f.name && composerText.includes(f.name) && !baselineComposerText.includes(f.name)
                );
                if (newlyMatchedNames.length > 0) {
                  if (this.chipSettleMs > 0) {
                    await delay(this.chipSettleMs);
                  }
                  if (!isUploadBusy(composerRoot)) {
                    logger('UPLOAD', 'info', `Verified ${newlyMatchedNames.length} file name(s) in composer text`);
                    this.transition(UPLOAD_STATES.READY, { verifiedCount: newlyMatchedNames.length, mode: 'composer_file_name_match' });
                    return true;
                  }
                  continue;
                }
              }
            }
          }
        }
        await delay(200);
      }

      return false;
    }

    /**
     * Executes the complete upload lifecycle with bounded retry support.
     * If files is empty/null, transitions directly IDLE -> READY.
     * @param {Array<object>} files
     * @param {object} provider
     * @param {object} [hooks]
     * @returns {Promise<{ state: string, count: number, strategy: string, attempts: number }>}
     */
    async executeUpload(files, provider, hooks = {}) {
      if (this.state !== UPLOAD_STATES.IDLE) {
        this.reset();
      }

      if (!files || (Array.isArray(files) && files.length === 0)) {
        this.transition(UPLOAD_STATES.READY, { count: 0, skipped: true });
        return { state: this.state, count: 0, strategy: 'none', attempts: 0 };
      }

      const normalized = this.validatePayloads(files);
      const fileObjects = this.prepareFiles(normalized);
      const baseline = this.captureBaseline(provider);

      let attempts = 0;
      let lastStrategy = 'none';

      while (attempts <= this.maxRetries) {
        attempts++;
        const injection = await this.injectIntoDOM(fileObjects, provider, {
          ...hooks,
          attempt: attempts,
          lastStrategy
        });
        lastStrategy = injection.strategy;

        const verified = await this.verifyDOMAttachment(provider, fileObjects.length, hooks, fileObjects, baseline);
        if (verified && this.state === UPLOAD_STATES.READY) {
          return {
            state: this.state,
            count: fileObjects.length,
            strategy: lastStrategy,
            attempts
          };
        }

        if (attempts <= this.maxRetries) {
          await delay(250 * attempts);
        }
      }

      // If injection succeeded and no busy progressbar is running, proceed with grace ready
      // to avoid leaving files stranded in the composer when provider chip markup changes
      const busySelectors = (provider && provider.uploadBusySelectors) || [];
      const composerRoot = resolveComposerContainer(provider);
      const isBusy =
        busySelectors.length > 0 &&
        typeof document !== 'undefined' &&
        collectMatchingElements(busySelectors, composerRoot || document, {
          requireVisible: true,
          excludeHistory: true
        }).length > 0;

      if (lastStrategy !== 'none' && !isBusy) {
        this.transition(UPLOAD_STATES.READY, {
          verifiedCount: fileObjects.length,
          mode: 'grace_proceed',
          attempts
        });
        return {
          state: this.state,
          count: fileObjects.length,
          strategy: lastStrategy,
          attempts
        };
      }

      const err = new Error(
        `Upload verification timed out after ${attempts} attempt(s) on provider "${provider ? provider.id : 'unknown'}"`
      );
      err.code = 'ERR_UPLOAD_VERIFY_TIMEOUT';
      this.lastError = err;
      this.transition(UPLOAD_STATES.FAILED, { code: err.code, attempts });
      throw err;
    }
  }

  return {
    UPLOAD_STATES,
    ALLOWED_TRANSITIONS,
    DEFAULT_MAX_FILE_BYTES,
    sanitizeFileName,
    buildFileObject,
    resolveComposerContainer,
    filesMatchBatch,
    UploadStateMachine
  };
});
