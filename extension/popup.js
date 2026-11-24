/**
 * WebAI Bridge - Popup Controller ("Obsidian Signal")
 * Manages WebSocket port configuration, per-session authentication token storage,
 * live status telemetry, and debug log controls for the active Web AI tab.
 */
(function () {
  'use strict';

  const DEFAULT_PORT = 4545;
  const SVG_NS = 'http://www.w3.org/2000/svg';

  function validatePort(value) {
    const num = Number(value);
    return Number.isInteger(num) && num >= 1024 && num <= 65535 ? num : null;
  }

  function getManifestVersion() {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.getManifest === 'function') {
        const manifest = chrome.runtime.getManifest();
        if (manifest && manifest.version) {
          return String(manifest.version);
        }
      }
    } catch (_) {
      // Ignore outside Chrome extension runtime
    }
    return '';
  }

  /**
   * Maps a tab status payload into canonical Obsidian Signal UI state semantics.
   * @param {object|null|undefined} status
   * @returns {{ state: string, badgeText: string, tabMode: string }}
   */
  function resolveConnectionState(status) {
    if (!status || !status.ok) {
      return { state: 'disconnected', badgeText: 'No AI Tab', tabMode: 'Offline' };
    }
    if (status.busy || status.isBusy || status.activeRequestId || status.activeJobId) {
      return { state: 'busy', badgeText: 'Busy', tabMode: 'Busy' };
    }
    if (status.wasReplaced) {
      return { state: 'replaced', badgeText: 'Replaced', tabMode: 'Replaced' };
    }
    if (status.dedicated === false) {
      return { state: 'standby', badgeText: 'Standby', tabMode: 'Standby' };
    }
    if (status.connected) {
      return { state: 'connected', badgeText: 'Connected', tabMode: 'Dedicated' };
    }
    if (status.connecting) {
      return { state: 'connecting', badgeText: 'Connecting...', tabMode: 'Connecting' };
    }
    if (status.lastError) {
      return { state: 'error', badgeText: 'Error', tabMode: 'Offline' };
    }
    return { state: 'disconnected', badgeText: 'Disconnected', tabMode: 'Offline' };
  }

  function sendTabMessageSafe(tabId, message, onDone) {
    if (typeof chrome === 'undefined' || !chrome.tabs || typeof chrome.tabs.sendMessage !== 'function') {
      if (typeof onDone === 'function') onDone(null, new Error('Extension API not available'));
      return;
    }
    try {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        const lastErr = chrome.runtime && chrome.runtime.lastError ? chrome.runtime.lastError : null;
        if (typeof onDone === 'function') {
          onDone(lastErr ? null : response, lastErr);
        }
      });
    } catch (err) {
      if (typeof onDone === 'function') onDone(null, err);
    }
  }

  function queryActiveTab(onTab) {
    if (typeof chrome === 'undefined' || !chrome.tabs || typeof chrome.tabs.query !== 'function') {
      onTab(null, new Error('Extension API not available'));
      return;
    }
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const lastErr = chrome.runtime && chrome.runtime.lastError ? chrome.runtime.lastError : null;
        if (lastErr) {
          onTab(null, lastErr);
          return;
        }
        onTab(tabs && tabs[0] ? tabs[0] : null, null);
      });
    } catch (err) {
      onTab(null, err);
    }
  }

  function buildEyeSvg(isVisible) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');

    if (isVisible) {
      const p1 = document.createElementNS(SVG_NS, 'path');
      p1.setAttribute('d', 'M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-10-8-10-8a18.45 18.45 0 0 1 5.06-5.94');
      const p2 = document.createElementNS(SVG_NS, 'path');
      p2.setAttribute('d', 'M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 10 8 10 8a18.5 18.5 0 0 1-2.16 3.19');
      const p3 = document.createElementNS(SVG_NS, 'path');
      p3.setAttribute('d', 'M14.12 14.12a3 3 0 1 1-4.24-4.24');
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', '2');
      line.setAttribute('y1', '2');
      line.setAttribute('x2', '22');
      line.setAttribute('y2', '22');
      svg.appendChild(p1);
      svg.appendChild(p2);
      svg.appendChild(p3);
      svg.appendChild(line);
    } else {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z');
      const circle = document.createElementNS(SVG_NS, 'circle');
      circle.setAttribute('cx', '12');
      circle.setAttribute('cy', '12');
      circle.setAttribute('r', '3');
      svg.appendChild(path);
      svg.appendChild(circle);
    }
    return svg;
  }

  function initPopup() {
    if (typeof document === 'undefined') return;

    const bridgeTitle = document.getElementById('bridgeTitle');
    const connectionBadge = document.getElementById('connectionBadge');
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    const providerValue = document.getElementById('providerValue');
    const tabModeValue = document.getElementById('tabModeValue');
    const uploadStateValue = document.getElementById('uploadStateValue');
    const jobValue = document.getElementById('jobValue');
    const portInput = document.getElementById('portInput');
    const tokenInput = document.getElementById('tokenInput');
    const toggleTokenBtn = document.getElementById('toggleTokenBtn');
    const saveBtn = document.getElementById('saveBtn');
    const refreshBtn = document.getElementById('refreshBtn');
    const feedbackMsg = document.getElementById('feedbackMsg');
    const debugToggle = document.getElementById('debugToggle');
    const copyLogsBtn = document.getElementById('copyLogsBtn');
    const clearLogsBtn = document.getElementById('clearLogsBtn');

    if (bridgeTitle) {
      const version = getManifestVersion();
      bridgeTitle.textContent = version ? `WebAI Bridge v${version}` : 'WebAI Bridge';
    }

    function setFeedback(text, kind) {
      if (!feedbackMsg) return;
      feedbackMsg.textContent = text || '';
      const validKind = ['info', 'success', 'warn', 'error'].includes(kind) ? `is-${kind}` : '';
      feedbackMsg.className = validKind ? `status-msg ${validKind}` : 'status-msg';
    }

    function updateStatusUI(status) {
      const resolved = resolveConnectionState(status);

      if (connectionBadge) {
        connectionBadge.setAttribute('data-state', resolved.state);
        connectionBadge.className = `badge ${resolved.state}`;
      }
      if (statusDot) {
        statusDot.className = `dot ${resolved.state}`;
      }
      if (statusText) {
        statusText.textContent = resolved.badgeText;
      }
      if (tabModeValue) {
        tabModeValue.textContent = resolved.tabMode;
      }

      if (!status || !status.ok) {
        if (providerValue) providerValue.textContent = 'None';
        if (uploadStateValue) uploadStateValue.textContent = 'IDLE';
        if (jobValue) jobValue.textContent = 'None';
        return;
      }

      if (providerValue) {
        providerValue.textContent = status.providerName || status.provider || 'None';
      }
      if (uploadStateValue) {
        uploadStateValue.textContent = status.uploadState || 'IDLE';
      }
      if (jobValue) {
        jobValue.textContent = status.activeJobId || status.activeRequestId || 'None';
      }
    }

    function queryActiveTabStatus() {
      queryActiveTab((activeTab, err) => {
        if (err || !activeTab || !activeTab.id) {
          updateStatusUI(null);
          return;
        }
        sendTabMessageSafe(activeTab.id, { type: 'WEBAI_GET_TAB_STATUS' }, (response, msgErr) => {
          if (msgErr || !response) {
            updateStatusUI(null);
            return;
          }
          updateStatusUI(response);
        });
      });
    }

    function handleSaveAndReconnect() {
      const validPort = validatePort(portInput ? portInput.value : DEFAULT_PORT);
      if (!validPort) {
        setFeedback('Port must be between 1024 and 65535', 'error');
        return;
      }
      const authToken = tokenInput ? tokenInput.value.trim() : '';

      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set(
          {
            bridgePort: validPort,
            bridgeAuthToken: authToken
          },
          () => {
            if (chrome.runtime && chrome.runtime.lastError) {
              setFeedback('Failed to save settings', 'error');
              return;
            }
            setFeedback(`Saved port ${validPort} — reconnecting...`, 'info');
            queryActiveTab((activeTab, err) => {
              if (err || !activeTab || !activeTab.id) {
                setFeedback(`Saved port ${validPort}`, 'success');
                return;
              }
              sendTabMessageSafe(
                activeTab.id,
                {
                  type: 'WEBAI_RECONFIGURE_BRIDGE',
                  port: validPort,
                  authToken
                },
                (_res, msgErr) => {
                  if (msgErr) {
                    setFeedback(`Saved port ${validPort} (open a supported AI tab)`, 'warn');
                    updateStatusUI(null);
                    return;
                  }
                  setFeedback(`Reconnected on port ${validPort}`, 'success');
                  setTimeout(queryActiveTabStatus, 350);
                }
              );
            });
          }
        );
      }
    }

    // Load persisted settings
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(['bridgePort', 'bridgeAuthToken', 'debugMode'], (items) => {
        if (chrome.runtime && chrome.runtime.lastError) return;
        if (portInput) {
          portInput.value = validatePort(items && items.bridgePort) || DEFAULT_PORT;
        }
        if (tokenInput && items && typeof items.bridgeAuthToken === 'string') {
          tokenInput.value = items.bridgeAuthToken;
        }
        if (debugToggle && items) {
          debugToggle.checked = Boolean(items.debugMode);
        }
      });
    }

    // Token show/hide toggle
    if (toggleTokenBtn && tokenInput) {
      toggleTokenBtn.addEventListener('click', () => {
        const nextVisible = tokenInput.type === 'password';
        tokenInput.type = nextVisible ? 'text' : 'password';
        toggleTokenBtn.setAttribute('aria-pressed', String(nextVisible));
        toggleTokenBtn.setAttribute('aria-label', nextVisible ? 'Hide token' : 'Show token');
        while (toggleTokenBtn.firstChild) {
          toggleTokenBtn.removeChild(toggleTokenBtn.firstChild);
        }
        toggleTokenBtn.appendChild(buildEyeSvg(nextVisible));
      });
    }

    // Enter-to-save on configuration inputs
    const onInputKeydown = (evt) => {
      if (evt.key === 'Enter') {
        evt.preventDefault();
        handleSaveAndReconnect();
      }
    };
    if (portInput) portInput.addEventListener('keydown', onInputKeydown);
    if (tokenInput) tokenInput.addEventListener('keydown', onInputKeydown);

    if (saveBtn) {
      saveBtn.addEventListener('click', handleSaveAndReconnect);
    }

    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        setFeedback('Status refreshed', 'info');
        queryActiveTabStatus();
      });
    }

    if (debugToggle) {
      debugToggle.addEventListener('change', () => {
        const enabled = Boolean(debugToggle.checked);
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
          chrome.storage.local.set({ debugMode: enabled }, () => {
            if (chrome.runtime && chrome.runtime.lastError) {
              setFeedback('Failed to save debug mode', 'error');
              return;
            }
            setFeedback(enabled ? 'Debug logging enabled' : 'Debug logging disabled', 'info');
            queryActiveTab((activeTab, err) => {
              if (err || !activeTab || !activeTab.id) return;
              sendTabMessageSafe(
                activeTab.id,
                { type: 'WEBAI_SET_DEBUG_MODE', debugMode: enabled, enabled },
                () => {
                  // Ignore missing content script on non-AI tabs
                }
              );
            });
          });
        }
      });
    }

    if (copyLogsBtn) {
      copyLogsBtn.addEventListener('click', () => {
        queryActiveTab((activeTab, err) => {
          if (err) {
            setFeedback('Extension API not available', 'error');
            return;
          }
          if (!activeTab || !activeTab.id) {
            setFeedback('No active tab found', 'warn');
            return;
          }
          sendTabMessageSafe(activeTab.id, { type: 'WEBAI_GET_DEBUG_LOGS' }, (res, msgErr) => {
            if (msgErr) {
              setFeedback('Open a supported AI tab to copy logs', 'warn');
              return;
            }
            const logs = res && Array.isArray(res.logs) ? res.logs : [];
            if (logs.length === 0) {
              setFeedback('No logs in buffer', 'info');
              return;
            }
            const text = logs
              .map((l) => `[${l.iso || new Date(l.timestamp).toISOString()}] [${l.category}] [${(l.level || 'info').toUpperCase()}] ${l.message}${l.details !== undefined && l.details !== null ? ' ' + JSON.stringify(l.details) : ''}`)
              .join('\n');
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(text).then(() => {
                setFeedback(`Copied ${logs.length} log entries`, 'success');
              }).catch(() => {
                setFeedback('Clipboard write failed', 'error');
              });
            } else {
              setFeedback(`${logs.length} logs available`, 'info');
            }
          });
        });
      });
    }

    if (clearLogsBtn) {
      clearLogsBtn.addEventListener('click', () => {
        queryActiveTab((activeTab, err) => {
          if (err || !activeTab || !activeTab.id) {
            setFeedback('No active tab found', 'warn');
            return;
          }
          sendTabMessageSafe(activeTab.id, { type: 'WEBAI_CLEAR_DEBUG_LOGS' }, (_res, msgErr) => {
            if (msgErr) {
              setFeedback('Open a supported AI tab to clear logs', 'warn');
              return;
            }
            setFeedback('Log buffer cleared', 'success');
          });
        });
      });
    }

    queryActiveTabStatus();
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initPopup, { once: true });
    } else {
      initPopup();
    }
  }

  if (typeof module === 'object' && module.exports) {
    module.exports = { DEFAULT_PORT, validatePort, getManifestVersion, resolveConnectionState };
  }
})();
