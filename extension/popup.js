/**
 * WebAI Bridge - Popup Controller
 * Manages WebSocket port configuration, per-session authentication token storage,
 * and live status inspection of the active Web AI tab.
 */
(function () {
  'use strict';

  const DEFAULT_PORT = 4545;

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
      // Ignore outside extension context
    }
    return '';
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

  function initPopup() {
    if (typeof document === 'undefined') return;

    const bridgeTitle = document.getElementById('bridgeTitle');
    const portInput = document.getElementById('portInput');
    const tokenInput = document.getElementById('tokenInput');
    const saveBtn = document.getElementById('saveBtn');
    const refreshBtn = document.getElementById('refreshBtn');
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    const providerValue = document.getElementById('providerValue');
    const uploadStateValue = document.getElementById('uploadStateValue');
    const jobValue = document.getElementById('jobValue');
    const feedbackMsg = document.getElementById('feedbackMsg');
    const debugToggle = document.getElementById('debugToggle');
    const copyLogsBtn = document.getElementById('copyLogsBtn');
    const clearLogsBtn = document.getElementById('clearLogsBtn');

    if (bridgeTitle) {
      const version = getManifestVersion();
      bridgeTitle.textContent = version ? `WebAI Bridge v${version}` : 'WebAI Bridge';
    }

    function setFeedback(text, isError) {
      if (!feedbackMsg) return;
      feedbackMsg.textContent = text;
      feedbackMsg.style.color = isError ? '#ef4444' : '#38bdf8';
    }

    function updateStatusUI(status) {
      if (!status || !status.ok) {
        statusDot.className = 'dot disconnected';
        statusText.textContent = 'Unsupported Tab';
        providerValue.textContent = 'None';
        uploadStateValue.textContent = 'IDLE';
        jobValue.textContent = 'None';
        return;
      }

      providerValue.textContent = status.providerName || status.provider || 'Detected';
      uploadStateValue.textContent = status.uploadState || 'IDLE';
      jobValue.textContent = status.activeRequestId || 'Idle';

      if (status.connected) {
        statusDot.className = status.busy ? 'dot busy' : 'dot connected';
        statusText.textContent = status.busy ? 'Streaming...' : `Connected (:${status.port})`;
      } else if (status.wasReplaced) {
        statusDot.className = 'dot disconnected';
        statusText.textContent = 'Replaced (Click Save)';
      } else {
        statusDot.className = 'dot disconnected';
        statusText.textContent = `Offline (:${status.port || DEFAULT_PORT})`;
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

    // Load saved settings
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

    if (debugToggle) {
      debugToggle.addEventListener('change', () => {
        const enabled = Boolean(debugToggle.checked);
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
          chrome.storage.local.set({ debugMode: enabled }, () => {
            if (chrome.runtime && chrome.runtime.lastError) {
              setFeedback('Failed to save debug mode', true);
              return;
            }
            setFeedback(enabled ? 'Debug mode enabled (detailed logs)' : 'Debug mode disabled', false);
            queryActiveTab((activeTab, err) => {
              if (err || !activeTab || !activeTab.id) return;
              sendTabMessageSafe(
                activeTab.id,
                { type: 'WEBAI_SET_DEBUG_MODE', debugMode: enabled },
                () => {
                  // Intentionally swallow lastError on non-supported tabs while keeping setting persisted
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
            setFeedback('Extension API not available', true);
            return;
          }
          if (!activeTab || !activeTab.id) {
            setFeedback('No active tab found', true);
            return;
          }
          sendTabMessageSafe(activeTab.id, { type: 'WEBAI_GET_DEBUG_LOGS' }, (res, msgErr) => {
            if (msgErr) {
              setFeedback('Unsupported tab', true);
              return;
            }
            const logs = (res && Array.isArray(res.logs)) ? res.logs : [];
            if (logs.length === 0) {
              setFeedback('No logs in buffer', false);
              return;
            }
            const text = logs
              .map((l) => `[${l.iso || new Date(l.timestamp).toISOString()}] [${l.category}] [${(l.level || 'info').toUpperCase()}] ${l.message} ${l.details ? JSON.stringify(l.details) : ''}`)
              .join('\n');
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(text).then(() => {
                setFeedback(`${logs.length} logs copied!`, false);
              }).catch(() => {
                setFeedback('Clipboard error', true);
              });
            } else {
              setFeedback(`${logs.length} logs available`, false);
            }
          });
        });
      });
    }

    if (clearLogsBtn) {
      clearLogsBtn.addEventListener('click', () => {
        queryActiveTab((activeTab, err) => {
          if (err || !activeTab || !activeTab.id) {
            setFeedback('No active tab found', true);
            return;
          }
          sendTabMessageSafe(activeTab.id, { type: 'WEBAI_CLEAR_DEBUG_LOGS' }, (_res, msgErr) => {
            if (msgErr) {
              setFeedback('Unsupported tab', true);
              return;
            }
            setFeedback('Log buffer cleared', false);
          });
        });
      });
    }

    if (saveBtn) {
      saveBtn.addEventListener('click', () => {
        const validPort = validatePort(portInput ? portInput.value : DEFAULT_PORT);
        if (!validPort) {
          setFeedback('Port must be between 1024 and 65535', true);
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
                setFeedback('Failed to save settings', true);
                return;
              }
              setFeedback(`Saved port ${validPort} & reconnecting...`, false);
              queryActiveTab((activeTab, err) => {
                if (err || !activeTab || !activeTab.id) {
                  setFeedback(`Saved port ${validPort}`, false);
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
                      setFeedback(`Saved port ${validPort} (open a supported AI tab)`, false);
                      updateStatusUI(null);
                      return;
                    }
                    setTimeout(queryActiveTabStatus, 350);
                  }
                );
              });
            }
          );
        }
      });
    }

    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        setFeedback('Status refreshed', false);
        queryActiveTabStatus();
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
    module.exports = { DEFAULT_PORT, validatePort, getManifestVersion };
  }
})();
