/**
 * WebAI Bridge - Milestone 4 Unit & Architectural Verification Suite
 * Covers:
 *   1. Modular content script architecture (providers, upload, core, unified facade)
 *   2. DeepSeek hash-free selectors & ChatGPT assistant-scoped selector precedence
 *   3. Formal UploadStateMachine transitions, validation, retries & rollback
 *   4. Configurable canonical port (4545) & per-session cryptographic WebSocket authentication
 *   5. Anti-timeout (180s+) streaming buffer, soft-deadline preemption & idempotent polling
 *   6. Provider response extraction scoping & headless Gemini null-document resolver safety
 *   7. UploadStateMachine Tier 1 multi-turn overwrite, Tier 2 lazy input click & baseline chip delta
 *   8. Large-prompt fallback, multi-tab replacement suppression, check_session fields & startup timeout
 *   9. Live diagnostics composer-container resolution (parent container vs input element)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

import {
  DEFAULT_WS_PORT,
  resolveBridgePort,
  generateSessionToken,
  safeTokenCompare,
  isAllowedOrigin,
  SessionAuthManager
} from '../extension/session-auth.mjs';

import {
  JOB_STATUS,
  computePromptFingerprint,
  ResponseBufferManager
} from '../extension/response-buffer.mjs';

const require = createRequire(import.meta.url);
const ContentFacade = require('../extension/content.js');
const ProvidersMod = require('../extension/content-providers.js');
const UploadMod = require('../extension/content-upload.js');
const CoreMod = require('../extension/content-core.js');
const PopupMod = require('../extension/popup.js');

test('Milestone 4.1 - Modular content.js architecture exports all sub-modules cleanly', () => {
  assert.ok(ContentFacade.PROVIDERS, 'PROVIDERS registry should be exported');
  assert.equal(typeof ContentFacade.detectProvider, 'function');
  assert.equal(typeof ContentFacade.UploadStateMachine, 'function');
  assert.equal(typeof ContentFacade.BridgeContentRuntime, 'function');
  assert.equal(typeof ContentFacade.buildWebSocketUrl, 'function');
  assert.equal(typeof ContentFacade.prepareLargePromptPayload, 'function');
  assert.equal(typeof ContentFacade.resolveComposerContainer, 'function');
  assert.equal(typeof ContentFacade.filesMatchBatch, 'function');
  assert.equal(ContentFacade.DEFAULT_BRIDGE_PORT, 4545);
  assert.equal(ContentFacade.FILE_UPLOAD_THRESHOLD, 20000);
  assert.equal(ContentFacade.DEFAULT_STARTUP_TIMEOUT_MS, 45000);

  for (const id of ['gemini', 'claude', 'chatgpt', 'deepseek', 'aistudio']) {
    assert.ok(ProvidersMod.PROVIDERS[id], `Provider ${id} must be defined`);
    assert.ok(Array.isArray(ProvidersMod.PROVIDERS[id].inputSelectors));
    assert.ok(ProvidersMod.PROVIDERS[id].inputSelectors.length > 0);
  }
});

test('Milestone 4.2 - DeepSeek selectors and helpers are 100% free of hashed CSS module classes', () => {
  const ds = ProvidersMod.PROVIDERS.deepseek;
  assert.equal(ds.id, 'deepseek');
  assert.ok(ProvidersMod.detectProvider('chat.deepseek.com')?.id === 'deepseek');

  const allSelectorLists = [
    ds.inputSelectors,
    ds.sendButtonSelectors,
    ds.stopButtonSelectors,
    ds.streamingIndicators,
    ds.responseSelectors,
    ds.fileInputSelectors,
    ds.uploadTriggerSelectors,
    ds.attachmentChipSelectors,
    ds.artifactCleanupSelectors
  ];

  const hashedClassRegex = /\.(?:_[a-f0-9]{6,}|[a-f0-9]{7,}|[a-zA-Z0-9_-]+(?:__|--)([a-f0-9]{5,}))\b/i;
  for (const list of allSelectorLists) {
    for (const sel of list) {
      assert.equal(
        hashedClassRegex.test(sel),
        false,
        `Selector "${sel}" must not rely on unstable hashed CSS classes`
      );
    }
  }

  const helperSources = [
    ProvidersMod.findDeepSeekActionElement.toString(),
    CoreMod.collectTabDiagnostics.toString()
  ].join('\n');
  for (const legacyHash of ['_27c9245', 'aaff8b8f', '_77cefa5']) {
    assert.equal(helperSources.includes(legacyHash), false, `Helper source must not contain hashed class ${legacyHash}`);
  }

  const gptSelectors = ProvidersMod.PROVIDERS.chatgpt.responseSelectors;
  assert.ok(
    gptSelectors.indexOf('[data-message-author-role="assistant"] .markdown') < gptSelectors.indexOf('.markdown'),
    'ChatGPT assistant-scoped selector must precede bare .markdown'
  );

  assert.equal(typeof ds.customResolver.findSendButton, 'function');
  assert.equal(typeof ds.customResolver.findStopButton, 'function');
  assert.equal(typeof ds.customResolver.findUploadTrigger, 'function');
});

test('Milestone 4.3 - Formal UploadStateMachine enforces legal transitions and bounded retries', async () => {
  const sm = new UploadMod.UploadStateMachine({ maxRetries: 1 });
  assert.equal(sm.state, UploadMod.UPLOAD_STATES.IDLE);

  assert.throws(
    () => sm.transition(UploadMod.UPLOAD_STATES.INJECTING),
    (err) => err.code === 'ERR_INVALID_UPLOAD_TRANSITION'
  );

  const emptyRes = await sm.executeUpload([], ProvidersMod.PROVIDERS.gemini);
  assert.equal(emptyRes.state, UploadMod.UPLOAD_STATES.READY);
  assert.equal(emptyRes.count, 0);

  sm.reset();
  assert.equal(sm.state, UploadMod.UPLOAD_STATES.IDLE);

  let verifyAttempts = 0;
  const fullRes = await sm.executeUpload(
    [{ name: '../unsafe/path/spec.md', content: '# Spec', encoding: 'utf8' }],
    ProvidersMod.PROVIDERS.gemini,
    {
      injectFn: async () => ({ strategy: 'mock_data_transfer' }),
      verifyFn: async () => {
        verifyAttempts++;
        return verifyAttempts >= 2;
      }
    }
  );

  assert.equal(fullRes.state, UploadMod.UPLOAD_STATES.READY);
  assert.equal(fullRes.count, 1);
  assert.equal(fullRes.attempts, 2);
  assert.equal(fullRes.strategy, 'mock_data_transfer');

  const statesVisited = sm.getHistory().map((h) => h.to);
  assert.deepEqual(statesVisited.slice(-6), [
    UploadMod.UPLOAD_STATES.VALIDATING,
    UploadMod.UPLOAD_STATES.PREPARING,
    UploadMod.UPLOAD_STATES.INJECTING,
    UploadMod.UPLOAD_STATES.VERIFYING_DOM,
    UploadMod.UPLOAD_STATES.INJECTING,
    UploadMod.UPLOAD_STATES.VERIFYING_DOM,
    UploadMod.UPLOAD_STATES.READY
  ].slice(-6));
});

test('Milestone 4.4 - Configurable port (canonical 4545) and per-session WebSocket authentication', () => {
  assert.equal(DEFAULT_WS_PORT, 4545);
  assert.equal(resolveBridgePort({ argv: [], env: {} }), 4545);
  assert.equal(CoreMod.DEFAULT_BRIDGE_PORT, 4545);
  assert.equal(PopupMod.DEFAULT_PORT, 4545);
  assert.equal(PopupMod.validatePort('4545'), 4545);
  assert.equal(PopupMod.validatePort(80), null);
  assert.equal(typeof PopupMod.getManifestVersion(), 'string');

  assert.equal(resolveBridgePort({ argv: ['node', 'bridge.mjs', '--port', '9123'], env: {} }), 9123);
  assert.equal(resolveBridgePort({ argv: [], env: { WEBAI_BRIDGE_PORT: '9200' } }), 9200);
  assert.throws(() => resolveBridgePort({ port: 80 }), /Invalid WebAI Bridge port/);

  const token = generateSessionToken(32);
  assert.equal(token.length, 64);
  assert.equal(safeTokenCompare(token, token), true);
  assert.equal(safeTokenCompare(token, 'wrong_token'), false);

  assert.equal(isAllowedOrigin('https://gemini.google.com'), true);
  assert.equal(isAllowedOrigin('https://chat.deepseek.com'), true);
  assert.equal(isAllowedOrigin('https://evil-attacker.example.com'), false);

  const tmpFile = path.join(os.tmpdir(), `webai-session-${Date.now()}.json`);
  const auth = new SessionAuthManager({
    port: 8899,
    token,
    requireToken: true,
    sessionFilePath: tmpFile
  });

  auth.persistSessionFile();
  assert.equal(fs.existsSync(tmpFile), true);
  const persisted = JSON.parse(fs.readFileSync(tmpFile, 'utf8'));
  assert.equal(persisted.port, 8899);
  assert.equal(persisted.token, token);

  const otherAuth = new SessionAuthManager({
    port: 8899,
    token: generateSessionToken(32),
    requireToken: true,
    sessionFilePath: tmpFile
  });
  otherAuth.cleanupSessionFile();
  assert.equal(fs.existsSync(tmpFile), true, 'Foreign session manager must not delete another session file');

  const badOriginCheck = auth.verifyUpgradeRequest({
    headers: { origin: 'https://malicious.site' },
    url: `/?token=${token}`
  });
  assert.equal(badOriginCheck.ok, false);
  assert.equal(badOriginCheck.code, 'ERR_WS_FORBIDDEN_ORIGIN');

  const missingTokenCheck = auth.verifyUpgradeRequest({
    headers: { origin: 'https://gemini.google.com' },
    url: '/'
  });
  assert.equal(missingTokenCheck.ok, false);
  assert.equal(missingTokenCheck.code, 'ERR_WS_INVALID_TOKEN');

  const validCheck = auth.verifyUpgradeRequest({
    headers: { origin: 'https://gemini.google.com' },
    url: `/?token=${token}`
  });
  assert.equal(validCheck.ok, true);
  assert.equal(validCheck.tokenVerified, true);

  const fakeWs = {};
  const handshake = auth.authenticateConnection(fakeWs, { authToken: token, provider: 'gemini' });
  assert.equal(handshake.ok, true);
  assert.ok(handshake.sessionSecret);
  assert.equal(auth.validateMessageAuth(fakeWs, { sessionSecret: handshake.sessionSecret }), true);
  assert.equal(auth.validateMessageAuth(fakeWs, { sessionSecret: 'forged_secret' }), false);

  auth.cleanupSessionFile();
  assert.equal(fs.existsSync(tmpFile), false);

  assert.equal(
    CoreMod.buildWebSocketUrl(8899, 'abc123token'),
    'ws://127.0.0.1:8899/?token=abc123token'
  );
  assert.equal(CoreMod.buildWebSocketUrl('invalid', ''), 'ws://127.0.0.1:4545');
});

test('Milestone 4.5 - Anti-timeout ResponseBufferManager preempts 180s deadline and resumes seamlessly', async () => {
  const cacheDir = path.join(os.tmpdir(), `webai-buffer-test-${Date.now()}`);
  const buffer = new ResponseBufferManager({
    softTimeoutMs: 80,
    hardTimeoutMs: 5000,
    cacheDir
  });

  const fpA = computePromptFingerprint({
    prompt: 'check',
    provider: 'gemini',
    files: [{ name: 'a.js', content: 'const x = 1;' }]
  });
  const fpB = computePromptFingerprint({
    prompt: 'check',
    provider: 'gemini',
    files: [{ name: 'a.js', content: 'const x = 2;' }]
  });
  assert.notEqual(fpA, fpB, 'Same-length edits to file content must produce distinct fingerprints');

  const { job, deduplicated } = buffer.createOrAttachJob({
    prompt: 'Design complete distributed rocket telemetry architecture',
    provider: 'gemini'
  });
  assert.equal(deduplicated, false);

  const secondAttach = buffer.createOrAttachJob({
    prompt: 'Design complete distributed rocket telemetry architecture',
    provider: 'gemini'
  });
  assert.equal(secondAttach.deduplicated, true);
  assert.equal(secondAttach.job.jobId, job.jobId);

  buffer.ingestStreamChunk({
    jobId: job.jobId,
    fullText: 'Part 1: Telemetry ingestion pipeline...',
    chunksEmitted: 1,
    isThinking: false
  });

  const firstWindow = await buffer.waitForWindowOrCompletion(job.jobId);
  assert.equal(firstWindow.status, 'partial_streaming');
  assert.equal(firstWindow.complete, false);
  assert.equal(firstWindow.jobId, job.jobId);
  assert.match(firstWindow.partialText, /Part 1: Telemetry ingestion pipeline/);
  assert.ok(firstWindow.resumeInstruction.includes(job.jobId));

  setTimeout(() => {
    buffer.ingestStreamChunk({
      jobId: job.jobId,
      fullText: 'Part 1: Telemetry ingestion pipeline...\nPart 2: Kalman filter fusion.',
      chunksEmitted: 2
    });
    buffer.completeJob(
      job.jobId,
      'Part 1: Telemetry ingestion pipeline...\nPart 2: Kalman filter fusion.\nPart 3: Complete.',
      { chunksEmitted: 3 }
    );
  }, 40);

  const secondWindow = await buffer.waitForWindowOrCompletion(job.jobId, { softTimeoutMs: 500 });
  assert.equal(secondWindow.status, 'completed');
  assert.equal(secondWindow.complete, true);
  assert.equal(
    secondWindow.text,
    'Part 1: Telemetry ingestion pipeline...\nPart 2: Kalman filter fusion.\nPart 3: Complete.'
  );
  assert.equal(secondWindow.chunksEmitted, 3);

  buffer.failJob(job.jobId, new Error('late disconnect'));
  assert.equal(buffer.getJob(job.jobId).status, JOB_STATUS.COMPLETED);

  fs.rmSync(cacheDir, { recursive: true, force: true });
});

test('Milestone 4.6 - extractCleanResponse speaker scoping & Gemini null-doc send resolver safety', () => {
  const makeContainer = (text) => ({
    querySelector: () => null,
    querySelectorAll: () => [],
    cloneNode() { return this; },
    innerText: text,
    textContent: text
  });

  const enLabel = ['ChatGPT', 'said:'].join(' ');
  const frLabel = ['ChatGPT', 'a', 'dit', ':'].join(' ');

  // Non-ChatGPT provider must preserve embedded speaker labels inside code blocks verbatim
  const geminiBody = `FILE: a.js\nconst label = "${enLabel}";\nconsole.log(label);`;
  const geminiOut = ProvidersMod.extractCleanResponse(
    makeContainer(geminiBody),
    ProvidersMod.PROVIDERS.gemini
  );
  assert.equal(geminiOut, geminiBody);

  // ChatGPT strips only the leading speaker label without truncating body occurrences
  const gptEnInput = `${enLabel}\nHere is the answer mentioning ${enLabel} inline.`;
  const gptEnOut = ProvidersMod.extractCleanResponse(
    makeContainer(gptEnInput),
    ProvidersMod.PROVIDERS.chatgpt
  );
  assert.equal(gptEnOut, `Here is the answer mentioning ${enLabel} inline.`);

  const gptFrOut = ProvidersMod.extractCleanResponse(
    makeContainer(`${frLabel}\nBonjour le monde`),
    ProvidersMod.PROVIDERS.chatgpt
  );
  assert.equal(gptFrOut, 'Bonjour le monde');

  // Gemini customResolver.findSendButton must not throw ReferenceError when global document is undefined
  const orphanRoot = {
    parentElement: null,
    querySelector: () => null,
    querySelectorAll: () => []
  };
  const detachedInput = {
    ownerDocument: null,
    parentElement: orphanRoot,
    nextElementSibling: null,
    closest: () => orphanRoot
  };
  assert.equal(ProvidersMod.PROVIDERS.gemini.customResolver.findSendButton(detachedInput), null);
});

test('Milestone 4.7 - UploadStateMachine Tier 1 multi-turn overwrite, Tier 2 lazy click, and baseline chip delta', async () => {
  const savedDocument = globalThis.document;
  const savedWindow = globalThis.window;
  const savedDataTransfer = globalThis.DataTransfer;
  const savedEvent = globalThis.Event;

  class MockDataTransfer {
    constructor() {
      this._files = [];
      this.items = { add: (f) => this._files.push(f) };
    }
    get files() {
      return this._files;
    }
  }
  class MockEvent {
    constructor(type, opts = {}) {
      this.type = type;
      this.bubbles = Boolean(opts.bubbles);
    }
  }

  const makeEl = (props = {}) => ({
    disabled: false,
    getAttribute: () => null,
    getBoundingClientRect: () => ({ width: 100, height: 30 }),
    closest: () => null,
    querySelectorAll: () => [],
    dispatchEvent: () => true,
    ...props
  });

  try {
    globalThis.DataTransfer = MockDataTransfer;
    globalThis.Event = MockEvent;
    globalThis.window = {
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' })
    };

    // 1. Tier 1: Follow-up turn overwrites stale Turn 1 input.files and waits for a NEW chip beyond baseline
    const oldChip = makeEl({ id: 'old-chip-turn1' });
    const newChip = makeEl({ id: 'new-chip-turn2' });
    const chipsInComposer = [oldChip];
    const eventsFired = [];

    const directFileInput = makeEl({
      value: 'C:\\fakepath\\turn1.txt',
      files: [{ name: 'turn1.txt', size: 10 }],
      dispatchEvent(evt) {
        eventsFired.push(evt.type);
        if (evt.type === 'change') {
          chipsInComposer.push(newChip);
        }
        return true;
      }
    });

    const composerEl = makeEl({
      innerText: 'turn1.txt',
      querySelectorAll(sel) {
        if (sel === 'uploader-file-preview') return chipsInComposer;
        return [];
      }
    });
    const editorEl = makeEl({
      parentElement: makeEl({
        closest: () => composerEl
      })
    });

    globalThis.document = {
      body: makeEl({ innerText: 'turn2.txt in old history' }),
      documentElement: makeEl(),
      querySelector(sel) {
        if (sel === 'input[type="file"]') return directFileInput;
        return null;
      },
      querySelectorAll(sel) {
        if (sel.includes('input[type="file"]')) return [directFileInput];
        if (sel.includes('ql-editor')) return [editorEl];
        if (sel === 'uploader-file-preview') return chipsInComposer;
        return [];
      }
    };

    const sm1 = new UploadMod.UploadStateMachine({ chipSettleMs: 10, verifyTimeoutMs: 500 });
    const res1 = await sm1.executeUpload(
      [{ name: 'turn2.txt', content: 'fresh payload for turn 2', encoding: 'utf8' }],
      ProvidersMod.PROVIDERS.gemini
    );
    assert.equal(res1.state, UploadMod.UPLOAD_STATES.READY);
    assert.equal(res1.strategy, 'direct_file_input', 'Turn 2 must inject new files instead of preserving Turn 1 input');
    assert.equal(directFileInput.files[0].name, 'turn2.txt');
    assert.ok(eventsFired.includes('change'));

    assert.equal(UploadMod.filesMatchBatch([{ name: 'a.txt', size: 3 }], [{ name: 'a.txt', size: 3 }]), true);
    assert.equal(UploadMod.filesMatchBatch([{ name: 'a.txt', size: 3 }], [{ name: 'b.txt', size: 3 }]), false);

    // 2. Tier 2: Trigger button click lazily mounts <input type="file"> asynchronously
    let lazyInput = null;
    let triggerClicked = false;
    const lazyChips = [];
    const lazyTriggerBtn = makeEl({
      click() {
        triggerClicked = true;
        setTimeout(() => {
          lazyInput = makeEl({
            value: '',
            files: [],
            dispatchEvent(evt) {
              if (evt.type === 'change') {
                lazyChips.push(makeEl({ id: 'lazy-chip' }));
              }
              return true;
            }
          });
        }, 30);
      }
    });

    const lazyComposer = makeEl({
      innerText: '',
      querySelectorAll(sel) {
        if (sel === 'uploader-file-preview') return lazyChips;
        return [];
      }
    });
    const lazyEditor = makeEl({
      parentElement: makeEl({ closest: () => lazyComposer })
    });

    globalThis.document = {
      body: makeEl(),
      documentElement: makeEl(),
      querySelector(sel) {
        if (sel === 'input[type="file"]') return lazyInput;
        return null;
      },
      querySelectorAll(sel) {
        if (sel.includes('input[type="file"]')) return lazyInput ? [lazyInput] : [];
        if (sel.includes('Add files')) return [lazyTriggerBtn];
        if (sel.includes('ql-editor')) return [lazyEditor];
        if (sel === 'uploader-file-preview') return lazyChips;
        return [];
      }
    };

    const sm2 = new UploadMod.UploadStateMachine({
      lazyInputTimeoutMs: 300,
      lazyInputPollMs: 15,
      chipSettleMs: 10,
      verifyTimeoutMs: 500
    });
    const res2 = await sm2.executeUpload(
      [{ name: 'lazy.txt', content: 'hello lazy input', encoding: 'utf8' }],
      ProvidersMod.PROVIDERS.gemini
    );
    assert.equal(triggerClicked, true, 'Tier 2 must call triggerBtn.click()');
    assert.equal(res2.strategy, 'lazy_file_input');
    assert.equal(res2.state, UploadMod.UPLOAD_STATES.READY);
    assert.equal(lazyInput.files[0].name, 'lazy.txt');
  } finally {
    if (savedDocument === undefined) delete globalThis.document;
    else globalThis.document = savedDocument;
    if (savedWindow === undefined) delete globalThis.window;
    else globalThis.window = savedWindow;
    if (savedDataTransfer === undefined) delete globalThis.DataTransfer;
    else globalThis.DataTransfer = savedDataTransfer;
    if (savedEvent === undefined) delete globalThis.Event;
    else globalThis.Event = savedEvent;
  }
});

test('Milestone 4.8 - Large-prompt fallback, replaced-tab reconnect suppression, check_session fields, and startup timeout', async () => {
  const small = CoreMod.prepareLargePromptPayload('short prompt', [{ name: 'a.js', content: '1' }]);
  assert.equal(small.converted, false);
  assert.equal(small.files.length, 1);

  const hugePrompt = 'X'.repeat(CoreMod.FILE_UPLOAD_THRESHOLD + 500);
  const large = CoreMod.prepareLargePromptPayload(hugePrompt, [{ name: 'a.js', content: '1' }]);
  assert.equal(large.converted, true);
  assert.equal(large.files.length, 2);
  assert.match(large.attachmentName, /^context_[a-z0-9]+\.txt$/);
  assert.equal(large.files[1].content, hugePrompt);
  assert.ok(large.prompt.includes(large.attachmentName));

  const rt = new CoreMod.BridgeContentRuntime({ provider: ProvidersMod.PROVIDERS.gemini });
  const sent = [];
  rt.ws = {
    readyState: 1,
    send(raw) { sent.push(JSON.parse(raw)); },
    close() {}
  };

  await rt.handleServerMessage({ type: 'check_session', id: 'sess_chk_1' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.busy, false);
  assert.equal(sent[0].payload.activeRequestId, null);
  assert.equal(sent[0].payload.uploadState, UploadMod.UPLOAD_STATES.IDLE);
  assert.equal(sent[0].payload.wasReplaced, false);

  await rt.handleServerMessage({ type: 'replaced' });
  assert.equal(rt.wasReplaced, true);
  rt.scheduleReconnect();
  assert.equal(rt.reconnectTimer, null, 'Replaced tab must NOT schedule automatic reconnect loop');

  let connectCalled = false;
  rt.connect = async () => { connectCalled = true; };
  await rt.reconfigure(4545, 'new_tok');
  assert.equal(rt.wasReplaced, false);
  assert.equal(rt.reconnectAttempts, 0);
  assert.equal(rt.port, 4545);
  assert.equal(rt.authToken, 'new_tok');
  assert.equal(connectCalled, true);

  await assert.rejects(
    () => CoreMod.captureStreamingResponse({
      provider: ProvidersMod.PROVIDERS.gemini,
      inputEl: null,
      baselineText: '',
      baselineCount: 0,
      startupTimeoutMs: 50,
      maxWaitMs: 500,
      tickMs: 15
    }),
    (err) => err.code === 'GENERATION_NOT_STARTED' && /Generation did not start/.test(err.message)
  );
});

test('Milestone 4.9 - collectTabDiagnostics resolves parent composer container instead of input element itself', () => {
  const savedDocument = globalThis.document;
  const savedWindow = globalThis.window;

  try {
    const composerHtml = '<div class="input-area-container"><div class="ql-editor new-input-ui"></div><button class="send-button"></button></div>';
    const composerNode = {
      tagName: 'DIV',
      outerHTML: composerHtml,
      querySelector: () => null,
      querySelectorAll: () => []
    };
    const inputNode = {
      tagName: 'DIV',
      id: '',
      classList: ['ql-editor', 'new-input-ui'],
      disabled: false,
      readOnly: false,
      textContent: 'hello',
      outerHTML: '<div class="ql-editor new-input-ui">hello</div>',
      getAttribute: () => null,
      hasAttribute: () => false,
      getBoundingClientRect: () => ({ width: 300, height: 40 }),
      closest: () => inputNode,
      parentElement: {
        parentElement: composerNode,
        closest: () => composerNode
      }
    };

    const bodyNode = { tagName: 'BODY' };
    const docEl = { tagName: 'HTML' };

    globalThis.window = {
      location: { href: 'https://gemini.google.com/app' },
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' })
    };
    globalThis.document = {
      title: 'Gemini',
      readyState: 'complete',
      activeElement: inputNode,
      body: bodyNode,
      documentElement: docEl,
      querySelectorAll(sel) {
        if (sel.includes('ql-editor')) return [inputNode];
        return [];
      }
    };

    const rt = new CoreMod.BridgeContentRuntime({ provider: ProvidersMod.PROVIDERS.gemini });
    const diag = CoreMod.collectTabDiagnostics(rt);
    assert.equal(diag.input.found, true);
    assert.equal(diag.composerSnippet, composerHtml);
  } finally {
    if (savedDocument === undefined) delete globalThis.document;
    else globalThis.document = savedDocument;
    if (savedWindow === undefined) delete globalThis.window;
    else globalThis.window = savedWindow;
  }
});

test('Milestone 4.10 - Obsidian Signal popup states, FloatingBridgePill lifecycle & Standby/Dedicated toggle', async () => {
  // 1. Popup state resolver across all semantic states
  assert.deepEqual(PopupMod.resolveConnectionState(null), { state: 'disconnected', badgeText: 'No AI Tab', tabMode: 'Offline' });
  assert.deepEqual(PopupMod.resolveConnectionState({ ok: false }), { state: 'disconnected', badgeText: 'No AI Tab', tabMode: 'Offline' });
  assert.deepEqual(PopupMod.resolveConnectionState({ ok: true, busy: true }), { state: 'busy', badgeText: 'Busy', tabMode: 'Busy' });
  assert.deepEqual(PopupMod.resolveConnectionState({ ok: true, wasReplaced: true }), { state: 'replaced', badgeText: 'Replaced', tabMode: 'Replaced' });
  assert.deepEqual(PopupMod.resolveConnectionState({ ok: true, dedicated: false }), { state: 'standby', badgeText: 'Standby', tabMode: 'Standby' });
  assert.deepEqual(PopupMod.resolveConnectionState({ ok: true, connected: true }), { state: 'connected', badgeText: 'Connected', tabMode: 'Dedicated' });
  assert.deepEqual(PopupMod.resolveConnectionState({ ok: true, connecting: true }), { state: 'connecting', badgeText: 'Connecting...', tabMode: 'Connecting' });
  assert.deepEqual(PopupMod.resolveConnectionState({ ok: true, lastError: 'ECONNREFUSED' }), { state: 'error', badgeText: 'Error', tabMode: 'Offline' });
  assert.deepEqual(PopupMod.resolveConnectionState({ ok: true }), { state: 'disconnected', badgeText: 'Disconnected', tabMode: 'Offline' });

  // 2. Pill state mapping & viewport clamping
  assert.equal(ContentFacade.resolvePillState({ connected: true }).label, 'Bridge \u00b7 Live');
  assert.equal(ContentFacade.resolvePillState({ busy: true, uploadState: 'IDLE' }).label, 'Bridge \u00b7 Busy');
  assert.equal(ContentFacade.resolvePillState({ busy: true, uploadState: 'INJECTING' }).label, 'Bridge \u00b7 Upload');
  assert.equal(ContentFacade.resolvePillState({ wasReplaced: true }).state, 'replaced');
  assert.equal(ContentFacade.resolvePillState({ dedicated: false }).label, 'Bridge \u00b7 Standby');
  assert.equal(ContentFacade.resolvePillState({ connecting: true }).state, 'connecting');
  assert.equal(ContentFacade.resolvePillState({ lastError: 'fail' }).state, 'error');

  assert.deepEqual(ContentFacade.clampPillPosition(-50, -10, 156, 32, 1280, 800), { x: 10, y: 10 });
  assert.deepEqual(ContentFacade.clampPillPosition(5000, 4000, 156, 32, 1280, 800), { x: 1114, y: 758 });
  assert.deepEqual(ContentFacade.clampPillPosition(Number.NaN, 100, 156, 32, 1280, 800), { x: 10, y: 100 });

  // 3. BridgeContentRuntime setDedicated / disconnect / onStateChange lifecycle
  const rt = new CoreMod.BridgeContentRuntime({ provider: ProvidersMod.PROVIDERS.gemini });
  const transitions = [];
  const unsubscribe = rt.onStateChange((s) => transitions.push(s));

  let closeArgs = null;
  rt.ws = { readyState: 1, close(code, reason) { closeArgs = { code, reason }; }, send() {} };
  await rt.setDedicated(false);
  assert.equal(rt.dedicated, false);
  assert.equal(rt.ws, null);
  assert.deepEqual(closeArgs, { code: 1000, reason: 'standby' });
  rt.scheduleReconnect();
  assert.equal(rt.reconnectTimer, null, 'Standby tab must not schedule reconnect loop');
  assert.equal(transitions[transitions.length - 1].dedicated, false);

  let connectInvoked = 0;
  rt.connect = async () => { connectInvoked++; };
  rt.wasReplaced = true;
  await rt.setDedicated(true);
  assert.equal(rt.dedicated, true);
  assert.equal(rt.wasReplaced, false);
  assert.equal(connectInvoked, 1);

  unsubscribe();
  const countBefore = transitions.length;
  rt.disconnect('cleanup');
  assert.equal(transitions.length, countBefore, 'Unsubscribed listener must not receive events');

  // 4. FloatingBridgePill Shadow-DOM mount, update, click toggle, and destroy cleanup
  const savedDocument = globalThis.document;
  const savedWindow = globalThis.window;
  const savedLocalStorage = globalThis.localStorage;

  try {
    function makeElement(tag) {
      const listeners = new Map();
      const attrs = new Map();
      const children = [];
      return {
        tagName: String(tag).toUpperCase(),
        style: {},
        children,
        firstChild: null,
        isConnected: false,
        shadowRoot: null,
        _textContent: '',
        get textContent() {
          return this._textContent;
        },
        set textContent(v) {
          this._textContent = String(v);
        },
        setAttribute(k, v) {
          attrs.set(k, String(v));
          if (k === 'id') this.id = String(v);
        },
        getAttribute(k) {
          return attrs.has(k) ? attrs.get(k) : null;
        },
        appendChild(child) {
          children.push(child);
          child.parentElement = this;
          child.isConnected = true;
          if (!this.firstChild) this.firstChild = child;
          return child;
        },
        remove() {
          this.isConnected = false;
          if (this.parentElement) {
            const idx = this.parentElement.children.indexOf(this);
            if (idx !== -1) this.parentElement.children.splice(idx, 1);
          }
        },
        contains(node) {
          if (node === this) return true;
          return children.some((c) => typeof c.contains === 'function' && c.contains(node));
        },
        addEventListener(evt, fn) {
          if (!listeners.has(evt)) listeners.set(evt, []);
          listeners.get(evt).push(fn);
        },
        dispatchEvent(evt) {
          const list = listeners.get(evt.type) || [];
          for (const fn of list) fn(evt);
        },
        querySelector(sel) {
          if (sel.startsWith('.')) {
            const cls = sel.slice(1);
            if (this.className && String(this.className).split(/\s+/).includes(cls)) return this;
          }
          for (const child of children) {
            if (typeof child.querySelector === 'function') {
              const hit = child.querySelector(sel);
              if (hit) return hit;
            }
          }
          return null;
        },
        attachShadow() {
          const sr = makeElement('SHADOW-ROOT');
          this.shadowRoot = sr;
          return sr;
        }
      };
    }

    const docEl = makeElement('HTML');
    const winListeners = new Map();
    const store = new Map([[ 'webai_bridge_pill_pos', JSON.stringify({ x: 9999, y: 24 }) ]]);

    globalThis.localStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v))
    };
    const fakeWin = {
      innerWidth: 1280,
      innerHeight: 800,
      addEventListener(evt, fn) {
        if (!winListeners.has(evt)) winListeners.set(evt, new Set());
        winListeners.get(evt).add(fn);
      },
      removeEventListener(evt, fn) {
        if (winListeners.has(evt)) winListeners.get(evt).delete(fn);
      }
    };
    fakeWin.top = fakeWin;
    fakeWin.self = fakeWin;
    globalThis.window = fakeWin;
    globalThis.document = {
      documentElement: docEl,
      body: null,
      getElementById: (id) => docEl.children.find((c) => c.id === id) || null,
      createElement: (tag) => makeElement(tag),
      createElementNS: (_ns, tag) => makeElement(tag)
    };

    const pillRuntime = {
      port: 4545,
      authToken: '',
      provider: ProvidersMod.PROVIDERS.gemini,
      dedicatedCalls: [],
      getStatusSummary: () => ({ ok: true, connected: true, dedicated: true, port: 4545, uploadState: 'IDLE' }),
      setDedicated: async (flag) => {
        pillRuntime.dedicatedCalls.push(flag);
      }
    };

    const pill = new ContentFacade.FloatingBridgePill(pillRuntime, { providerName: 'Google Gemini' });
    const host = pill.mount();
    assert.ok(host, 'FloatingBridgePill should mount host element in top-level frame');
    assert.equal(host.getAttribute('data-webai-bridge-ui'), 'true');
    assert.equal(host.style.left, '1114px', 'Stored x should clamp cleanly to viewport bounds');
    assert.equal(pill.buttonEl.getAttribute('data-state'), 'connected');
    assert.equal(pill.labelEl.textContent, 'Bridge \u00b7 Live');

    // Click when connected -> toggles Standby (false)
    pill.buttonEl.dispatchEvent({ type: 'click' });
    assert.deepEqual(pillRuntime.dedicatedCalls, [false]);

    // Click when busy -> must NOT interrupt active job
    pill.update({ ok: true, busy: true, uploadState: 'INJECTING', port: 4545 });
    assert.equal(pill.buttonEl.getAttribute('data-state'), 'busy');
    assert.equal(pill.labelEl.textContent, 'Bridge \u00b7 Upload');
    pill.buttonEl.dispatchEvent({ type: 'click' });
    assert.deepEqual(pillRuntime.dedicatedCalls, [false]);

    // Click when standby -> dedicates tab (true)
    pill.update({ ok: true, connected: false, dedicated: false, port: 4545 });
    assert.equal(pill.buttonEl.getAttribute('data-state'), 'standby');
    pill.buttonEl.dispatchEvent({ type: 'click' });
    assert.deepEqual(pillRuntime.dedicatedCalls, [false, true]);

    pill.destroy();
    assert.equal(host.isConnected, false);
    assert.equal((winListeners.get('pointermove') || new Set()).size, 0, 'destroy() must remove window pointermove listener');
  } finally {
    if (savedDocument === undefined) delete globalThis.document;
    else globalThis.document = savedDocument;
    if (savedWindow === undefined) delete globalThis.window;
    else globalThis.window = savedWindow;
    if (savedLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = savedLocalStorage;
  }
});

test('Milestone 4.11 - Slow multi-file upload extends verification while busy and never double-injects duplicates', async () => {
  const savedDocument = globalThis.document;
  const savedWindow = globalThis.window;
  const savedDataTransfer = globalThis.DataTransfer;
  const savedEvent = globalThis.Event;

  class MockDataTransfer {
    constructor() {
      const itemsList = [];
      this.files = itemsList;
      this.items = { add: (f) => itemsList.push(f) };
    }
  }
  class MockEvent {
    constructor(type, init = {}) {
      this.type = type;
      Object.assign(this, init);
    }
  }
  const makeEl = (props = {}) => ({
    tagName: 'DIV',
    style: {},
    files: [],
    value: '',
    innerText: '',
    textContent: '',
    children: [],
    getAttribute: () => null,
    hasAttribute: () => false,
    getBoundingClientRect: () => ({ width: 20, height: 20 }),
    contains(other) {
      if (other === this) return true;
      return this.children.some((c) => typeof c.contains === 'function' && c.contains(other));
    },
    closest: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    dispatchEvent: () => true,
    ...props
  });

  try {
    globalThis.DataTransfer = MockDataTransfer;
    globalThis.Event = MockEvent;
    globalThis.window = {
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' })
    };

    // Scenario A: React clears input.files immediately on change and spinner remains busy past verifyTimeoutMs (180ms -> finishes at 260ms).
    // Parent card contains nested Remove button; filterTopLevelElements must collapse both into 1 chip per file.
    let uploadInjectCount = 0;
    let spinnerActive = false;
    const spinnerEl = makeEl({ id: 'gpt-progress' });
    const composerChips = [];

    const reactFileInput = makeEl({
      files: [],
      dispatchEvent(evt) {
        if (evt.type === 'change') {
          uploadInjectCount++;
          spinnerActive = true;
          const card1 = makeEl({ id: 'card-1', children: [makeEl({ id: 'remove-1' })] });
          const card2 = makeEl({ id: 'card-2', children: [makeEl({ id: 'remove-2' })] });
          // Push both parent cards AND their nested remove buttons to ensure top-level dedup works
          composerChips.push(card1, card1.children[0], card2, card2.children[0]);
          setTimeout(() => {
            spinnerActive = false;
          }, 260);
          // React clears input.files immediately after processing change event
          this.files = [];
        }
        return true;
      }
    });

    const isBusySel = (sel) =>
      sel.includes('progressbar') ||
      sel.includes('animate-spin') ||
      sel.includes('aria-busy') ||
      sel.includes('stroke-dasharray');

    const slowComposer = makeEl({
      innerText: '',
      querySelectorAll(sel) {
        if (isBusySel(sel)) {
          return spinnerActive ? [spinnerEl] : [];
        }
        if (sel.includes('attachment') || sel.includes('Remove')) {
          return composerChips;
        }
        return [];
      }
    });
    const slowEditor = makeEl({
      parentElement: makeEl({ closest: () => slowComposer })
    });

    globalThis.document = {
      body: makeEl(),
      documentElement: makeEl(),
      querySelector: (sel) => (sel.includes('input[type="file"]') ? reactFileInput : null),
      querySelectorAll(sel) {
        if (sel.includes('input[type="file"]')) return [reactFileInput];
        if (sel.includes('prompt-textarea') || sel.includes('contenteditable')) return [slowEditor];
        if (isBusySel(sel)) return spinnerActive ? [spinnerEl] : [];
        if (sel.includes('attachment') || sel.includes('Remove')) return composerChips;
        return [];
      }
    };

    const smSlow = new UploadMod.UploadStateMachine({
      verifyTimeoutMs: 180,
      chipSettleMs: 10,
      maxRetries: 2
    });
    const slowRes = await smSlow.executeUpload(
      [
        { name: 'README.md', content: 'doc1', encoding: 'utf8' },
        { name: 'CHANGELOG.md', content: 'doc2', encoding: 'utf8' }
      ],
      ProvidersMod.PROVIDERS.chatgpt
    );
    assert.equal(uploadInjectCount, 1, 'Must NOT re-inject batch when spinner is actively uploading past base verifyTimeoutMs');
    assert.equal(slowRes.attempts, 1);
    assert.equal(slowRes.state, UploadMod.UPLOAD_STATES.READY);

    // Verify nested remove buttons inside parent card collapse cleanly
    const deduped = UploadMod.filterTopLevelElements(composerChips);
    assert.equal(deduped.length, 2, 'Nested remove buttons inside attachment cards must collapse to 2 top-level chips');

    // Scenario B: If Attempt 1 times out completely (hard cap reached while 1 partial chip appeared with spinner gone),
    // retry Attempt 2 must NOT re-inject the batch on top of existing composer chips!
    let partialInjectCount = 0;
    const partialCard = makeEl({ id: 'partial-only-card' });
    const partialInput = makeEl({
      files: [],
      dispatchEvent(evt) {
        if (evt.type === 'change') {
          partialInjectCount++;
          partialInput.files = [];
        }
        return true;
      }
    });
    let showPartial = false;
    const retryComposer = makeEl({
      innerText: '',
      querySelectorAll(sel) {
        if (isBusySel(sel)) return [];
        if (sel.includes('attachment') || sel.includes('Remove')) {
          return showPartial ? [partialCard] : [];
        }
        return [];
      }
    });
    const retryEditor = makeEl({
      parentElement: makeEl({ closest: () => retryComposer })
    });
    globalThis.document = {
      body: makeEl(),
      documentElement: makeEl(),
      querySelector: (sel) => (sel.includes('input[type="file"]') ? partialInput : null),
      querySelectorAll(sel) {
        if (sel.includes('input[type="file"]')) return [partialInput];
        if (sel.includes('prompt-textarea') || sel.includes('contenteditable')) return [retryEditor];
        if (isBusySel(sel)) return [];
        if (sel.includes('attachment') || sel.includes('Remove')) return showPartial ? [partialCard] : [];
        return [];
      }
    };

    const smPartial = new UploadMod.UploadStateMachine({
      verifyTimeoutMs: 60,
      chipSettleMs: 10,
      maxRetries: 1
    });
    const baseline = smPartial.captureBaseline(ProvidersMod.PROVIDERS.chatgpt);
    // Simulate Attempt 1 injected and left 1 chip behind
    partialInjectCount = 1;
    showPartial = true;
    assert.equal(
      UploadMod.hasComposerUploadActivity(ProvidersMod.PROVIDERS.chatgpt, baseline, [{ name: 'a.md' }, { name: 'b.md' }]),
      true
    );
    // Running executeUpload where baseline already captures no chip first, then chip appears on change:
    showPartial = false;
    partialInjectCount = 0;
    partialInput.dispatchEvent = (evt) => {
      if (evt.type === 'change') {
        partialInjectCount++;
        showPartial = true;
        partialInput.files = [];
      }
      return true;
    };
    const partialRes = await smPartial.executeUpload(
      [{ name: 'a.md', content: '1', encoding: 'utf8' }, { name: 'b.md', content: '2', encoding: 'utf8' }],
      ProvidersMod.PROVIDERS.chatgpt
    );
    assert.equal(partialInjectCount, 1, 'Attempt 2 must NEVER re-inject duplicate batch when chips already exist beyond baseline');
    assert.equal(partialRes.state, UploadMod.UPLOAD_STATES.READY);

    // Scenario C: Spinner exceeds Attempt 1 hardCapMs (verifyTimeoutMs: 50 -> hardCap 150ms; clears at 210ms)
    // Attempt 2 must skip injectIntoDOM, stay valid in VERIFYING_DOM without ERR_INVALID_UPLOAD_TRANSITION, and resolve READY.
    let retrySlowInjectCount = 0;
    let slowRetrySpinner = false;
    const retrySlowCard = makeEl({ id: 'slow-retry-card' });
    const retrySlowCards = [];
    const retrySlowInput = makeEl({
      files: [],
      dispatchEvent(evt) {
        if (evt.type === 'change') {
          retrySlowInjectCount++;
          slowRetrySpinner = true;
          retrySlowCards.push(retrySlowCard);
          setTimeout(() => {
            slowRetrySpinner = false;
          }, 210);
          this.files = [];
        }
        return true;
      }
    });
    const retrySlowComposer = makeEl({
      innerText: '',
      querySelectorAll(sel) {
        if (isBusySel(sel)) return slowRetrySpinner ? [makeEl({ id: 'spin' })] : [];
        if (sel.includes('attachment') || sel.includes('Remove')) return retrySlowCards;
        return [];
      }
    });
    const retrySlowEditor = makeEl({
      parentElement: makeEl({ closest: () => retrySlowComposer })
    });
    globalThis.document = {
      body: makeEl(),
      documentElement: makeEl(),
      querySelector: (sel) => (sel.includes('input[type="file"]') ? retrySlowInput : null),
      querySelectorAll(sel) {
        if (sel.includes('input[type="file"]')) return [retrySlowInput];
        if (sel.includes('prompt-textarea') || sel.includes('contenteditable')) return [retrySlowEditor];
        if (isBusySel(sel)) return slowRetrySpinner ? [makeEl({ id: 'spin' })] : [];
        if (sel.includes('attachment') || sel.includes('Remove')) return retrySlowCards;
        return [];
      }
    };
    const smHardTimeoutRetry = new UploadMod.UploadStateMachine({
      verifyTimeoutMs: 50,
      chipSettleMs: 10,
      maxRetries: 2
    });
    const slowRetryRes = await smHardTimeoutRetry.executeUpload(
      [{ name: 'slow.md', content: 'x', encoding: 'utf8' }],
      ProvidersMod.PROVIDERS.chatgpt
    );
    assert.equal(retrySlowInjectCount, 1, 'Retry after hard timeout must skip re-injection when composer shows active upload');
    assert.equal(slowRetryRes.attempts, 2);
    assert.equal(slowRetryRes.state, UploadMod.UPLOAD_STATES.READY);
  } finally {
    if (savedDocument === undefined) delete globalThis.document;
    else globalThis.document = savedDocument;
    if (savedWindow === undefined) delete globalThis.window;
    else globalThis.window = savedWindow;
    if (savedDataTransfer === undefined) delete globalThis.DataTransfer;
    else globalThis.DataTransfer = savedDataTransfer;
    if (savedEvent === undefined) delete globalThis.Event;
    else globalThis.Event = savedEvent;
  }
});

test('Milestone 4.12 - ChatGPT 2026 composer form priority, general file input priority, and DilResponse block newline extraction', () => {
  const savedDocument = globalThis.document;

  try {
    // 1. resolveComposerContainer must prefer outer <form data-chatgpt-composer> over inner div[class*="composer"]
    const outerForm = {
      tagName: 'FORM',
      querySelector: () => null
    };
    const innerWrapper = {
      tagName: 'DIV',
      className: 'Frame-HWLnAH composer-NYb0tQ',
      closest(sel) {
        if (sel.includes('form[data-chatgpt-composer]')) return outerForm;
        if (sel.includes('[class*="composer"]')) return innerWrapper;
        return null;
      }
    };
    const editor = {
      tagName: 'DIV',
      parentElement: innerWrapper,
      getBoundingClientRect: () => ({ width: 400, height: 40 }),
      getAttribute: () => null
    };

    globalThis.document = {
      body: { tagName: 'BODY' },
      documentElement: { tagName: 'HTML' },
      querySelector: () => outerForm,
      querySelectorAll(sel) {
        if (sel.includes('prompt-textarea') || sel.includes('ProseMirror')) return [editor];
        return [];
      }
    };
    const resolved = UploadMod.resolveComposerContainer(ProvidersMod.PROVIDERS.chatgpt);
    assert.equal(resolved, outerForm, 'Composer container must resolve to outer <form>, not inner ProseMirror wrapper');

    // 2. ChatGPT fileInputSelectors prioritize unrestricted multi-file input ahead of accept-restricted inputs
    const gptFileSelectors = ProvidersMod.PROVIDERS.chatgpt.fileInputSelectors;
    assert.ok(
      gptFileSelectors.indexOf('input[type="file"][multiple]:not([accept])') <
      gptFileSelectors.indexOf('input[type="file"][multiple]')
    );

    // 3. ChatGPT responseSelectors prioritize DilResponse / :assistant search units ahead of legacy .markdown
    const gptRespSelectors = ProvidersMod.PROVIDERS.chatgpt.responseSelectors;
    assert.ok(
      gptRespSelectors.indexOf('[data-chatgpt-search-unit-key$=":assistant"] [data-dil-response]') <
      gptRespSelectors.indexOf('[data-message-author-role="assistant"] .markdown')
    );

    // 4. extractCleanResponse preserves block newlines (<p>, <li>) on detached clones after stripping .sr-only
    const fakeTextNodes = [];
    const blockChildren = [];
    const srHeading = { remove() { srHeading.removed = true; } };
    const p1 = {
      tagName: 'P',
      _txt: '5 files:',
      get textContent() { return this._txt; },
      appendChild(n) { this._txt += n.textContent; }
    };
    const p2 = {
      tagName: 'P',
      _txt: 'TASK_COMPLETE',
      get textContent() { return this._txt; },
      appendChild(n) { this._txt += n.textContent; }
    };
    blockChildren.push(p1, p2);
    const fakeClone = {
      ownerDocument: {
        createTextNode: (t) => {
          const n = { textContent: t };
          fakeTextNodes.push(n);
          return n;
        }
      },
      querySelectorAll(sel) {
        if (sel === '.sr-only') return [srHeading];
        if (sel.startsWith('p,')) return blockChildren;
        return [];
      },
      get textContent() {
        return blockChildren.map((b) => b.textContent).join('');
      },
      get innerText() {
        return '5 files:TASK_COMPLETE';
      }
    };
    const liveTarget = {
      isConnected: true,
      cloneNode: () => fakeClone
    };
    const extracted = ProvidersMod.extractCleanResponse(liveTarget, ProvidersMod.PROVIDERS.chatgpt);
    assert.equal(srHeading.removed, true);
    assert.equal(extracted, '5 files:\nTASK_COMPLETE');
  } finally {
    if (savedDocument === undefined) delete globalThis.document;
    else globalThis.document = savedDocument;
  }
});
