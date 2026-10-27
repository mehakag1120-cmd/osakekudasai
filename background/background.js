// Session State variables
let isRecording = false;
let activeTabId = null;
let captureError = null;
let sessionStartTime = null;
let requestsInSession = 0;
let costInSession = 0;
let speedMode = 'fast'; // 'fast' or 'slow'
let rateLimitTimer = null;

// Message validation schema
function validateMessage(msg) {
  return msg && typeof msg === 'object' && 'type' in msg;
}

// Listeners
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!validateMessage(message)) {
    console.warn("Received malformed message:", message);
    return false;
  }

  switch (message.type) {
    case 'GET_STATUS':
      handleGetStatus(sendResponse);
      return true; // Keep response channel open

    case 'START_CAPTURE':
      handleStartCapture(message.tabId, sendResponse);
      return true;

    case 'STOP_CAPTURE':
      handleStopCapture(sendResponse);
      return true;

    case 'UPDATE_STATS':
      handleUpdateStats(message.durationSec, message.provider);
      return false;

    case 'TOKENIZED_RESULT':
      // Result received from Kuromoji tokenizer running in offscreen page
      forwardTokensToContentScript(message.tokens, message.text, message.startTime, message.endTime);
      return false;

    case 'LOOKUP_WORD':
      handleLookupWord(message.word, sendResponse);
      return true;

    case 'QUERY_VIDEO_TIME':
      if (activeTabId) {
        chrome.tabs.sendMessage(activeTabId, { type: 'QUERY_VIDEO_TIME' }, (response) => {
          if (chrome.runtime.lastError || !response) {
            sendResponse({ currentTime: Date.now() / 1000 });
          } else {
            sendResponse(response);
          }
        });
        return true; // async response channel
      } else {
        sendResponse({ currentTime: Date.now() / 1000 });
        return false;
      }

    case 'OFFSCREEN_READY':
      trySendInitCapture();
      return false;

    case 'RATE_LIMIT_HIT':
      handleRateLimitHit(message);
      return false;
  }
});

// GET STATUS
function handleGetStatus(sendResponse) {
  let durMins = 0;
  if (isRecording && sessionStartTime) {
    durMins = (Date.now() - sessionStartTime) / 60000;
  }
  
  const hrs = Math.floor(durMins / 60);
  const mins = Math.floor(durMins % 60);
  
  sendResponse({
    isRecording,
    durationText: `${hrs}h ${mins}m`,
    costText: `${requestsInSession} ($${costInSession.toFixed(4)})`,
    error: captureError
  });
}

// Pending capture configuration state (to prevent offscreen race condition)
let pendingCapture = null;

function trySendInitCapture() {
  if (pendingCapture) {
    chrome.runtime.sendMessage({
      type: 'INIT_CAPTURE',
      ...pendingCapture
    }).then(() => {
      console.log("Successfully initialized capture inside offscreen document.");
    }).catch(err => {
      console.log("Offscreen page not ready to receive message yet, waiting for OFFSCREEN_READY signal.");
    });
  }
}

// Load keys securely from env.json or .env if present
async function loadEnvIntoStorage() {
  try {
    let env = {};
    
    // 1. Try env.json first (clean JSON, never blocked by Chromium dotfile filters)
    try {
      const jsonRes = await fetch(chrome.runtime.getURL('env.json'));
      if (jsonRes.ok) {
        env = await jsonRes.json();
      }
    } catch (_) {}

    // 2. Fallback to .env text file parsing
    if (!env.GROQ_API_KEY && !env.OPENAI_API_KEY) {
      try {
        const url = chrome.runtime.getURL('.env');
        const res = await fetch(url);
        if (res.ok) {
          const text = await res.text();
          text.split('\n').forEach(line => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) return;
            const eqIdx = trimmed.indexOf('=');
            if (eqIdx !== -1) {
              const k = trimmed.slice(0, eqIdx).trim();
              const v = trimmed.slice(eqIdx + 1).trim();
              env[k] = v;
            }
          });
        }
      } catch (_) {}
    }

    const updates = {};
    if (env.GROQ_API_KEY) updates.groqApiKey = env.GROQ_API_KEY;
    if (env.GEMINI_API_KEY) updates.geminiApiKey = env.GEMINI_API_KEY;
    if (env.OPENAI_API_KEY) updates.openaiApiKey = env.OPENAI_API_KEY;

    if (Object.keys(updates).length > 0) {
      await chrome.storage.local.set(updates);
      console.log("Rikimashou: Environment keys loaded securely from env.json / .env");
    }
  } catch (e) {
    // Ignore, fallback to storage
  }
}

// START CAPTURE
async function handleStartCapture(tabId, sendResponse) {
  captureError = null;
  
  // Ensure keys from .env are synced first
  await loadEnvIntoStorage();

  // Verify API Key exists
  chrome.storage.local.get(['apiProvider', 'groqApiKey', 'geminiApiKey', 'openaiApiKey', 'silenceThreshold'], async (settings) => {
    const provider = settings.apiProvider || 'groq';
    let key = '';
    if (provider === 'groq') key = settings.groqApiKey || '';
    else if (provider === 'gemini') key = settings.geminiApiKey || '';
    else key = settings.openaiApiKey || '';
    
    if (!key) {
      captureError = `Missing API key for ${provider}. Add ${provider.toUpperCase()}_API_KEY to your .env file or configure Extension Settings.`;
      sendResponse({ error: captureError });
      return;
    }

    try {
      // 1. Injected content scripts (CSS and JS)
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content/content.js']
      }).catch(err => console.log("Content script already injected or page inaccessible."));
      
      await chrome.scripting.insertCSS({
        target: { tabId },
        files: ['content/content.css']
      }).catch(err => console.log("CSS already injected."));

      // 2. Initialize Offscreen document if needed
      await setupOffscreenDocument();

      // 3. Get MediaStream ID for tab capture
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
        if (chrome.runtime.lastError) {
          captureError = chrome.runtime.lastError.message;
          sendResponse({ error: captureError });
          return;
        }

        // Store capture parameters for offscreen document initialization
        pendingCapture = {
          streamId: streamId,
          tabId: tabId,
          apiProvider: provider,
          apiKey: key,
          groqApiKey: settings.groqApiKey || '',
          geminiApiKey: settings.geminiApiKey || '',
          openaiApiKey: settings.openaiApiKey || '',
          silenceThreshold: settings.silenceThreshold !== undefined ? settings.silenceThreshold : 0.015,
          speedMode: speedMode
        };

        // Try to initialize offscreen immediately (works if already loaded)
        trySendInitCapture();

        isRecording = true;
        activeTabId = tabId;
        sessionStartTime = Date.now();
        requestsInSession = 0;
        costInSession = 0;

        // Save session state for lifecycle recovery
        chrome.storage.session.set({ captureActive: true, activeTabId: tabId });

        // Tell content script to show overlay
        chrome.tabs.sendMessage(tabId, { type: 'SHOW_OVERLAY' }).catch(() => {});

        sendResponse({ success: true });
      });

    } catch (err) {
      captureError = err.message;
      sendResponse({ error: captureError });
    }
  });
}

// STOP CAPTURE
async function handleStopCapture(sendResponse) {
  isRecording = false;
  captureError = null;
  pendingCapture = null;
  
  chrome.storage.session.remove('captureActive');

  // Close offscreen document
  await closeOffscreenDocument();

  // Hide overlay in target tab
  if (activeTabId) {
    chrome.tabs.sendMessage(activeTabId, { type: 'HIDE_OVERLAY' }).catch(() => {});
    activeTabId = null;
  }

  sessionStartTime = null;
  if (sendResponse) sendResponse({ success: true });
}

async function setupOffscreenDocument() {
  // Force close any existing offscreen document to prevent orphaned pages from context reloads
  try {
    await chrome.offscreen.closeDocument();
  } catch (e) {
    // Ignore if none was open
  }
  
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen/offscreen.html',
      reasons: ['USER_MEDIA'],
      justification: 'Capture tab audio to perform real-time speech transcription'
    });
  } catch (err) {
    if (!err.message.includes('Only one offscreen document')) {
      throw err;
    }
  }
}

async function closeOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });
  if (contexts.length > 0) {
    await chrome.offscreen.closeDocument();
  }
}

// UPDATE SESSION STATS
function handleUpdateStats(durationSec, providerType) {
  requestsInSession++;
  const costRate = providerType === 'openai' ? (0.006 / 60) : 0.0;
  const estimatedCost = durationSec * costRate;
  costInSession += estimatedCost;
  updatePersistentStats(durationSec / 60, estimatedCost);
}

// UPDATE STATS
function updatePersistentStats(minutes, cost) {
  chrome.storage.local.get([
    'statDurationMinutes',
    'statRequestsCount',
    'statTotalCost'
  ], (stats) => {
    chrome.storage.local.set({
      statDurationMinutes: (stats.statDurationMinutes || 0) + minutes,
      statRequestsCount: (stats.statRequestsCount || 0) + 1,
      statTotalCost: (stats.statTotalCost || 0) + cost
    });
  });
}

// FORWARD TOKENS
function forwardTokensToContentScript(tokens, text, startTime, endTime) {
  if (activeTabId) {
    chrome.tabs.sendMessage(activeTabId, {
      type: 'RENDER_SUBTITLE',
      tokens,
      text,
      startTime,
      endTime
    }).catch(() => {});
  }
}

// LOOKUP WORD (Jotoba Fallback API)
async function handleLookupWord(word, sendResponse) {
  try {
    const response = await fetch('https://jotoba.de/api/search/words', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        query: word,
        language: 'English'
      })
    });

    if (!response.ok) {
      throw new Error(`Jotoba returned status ${response.status}`);
    }

    const data = await response.json();
    sendResponse({ result: data });
  } catch (err) {
    console.error("Jotoba lookup failed:", err.message);
    sendResponse({ error: err.message });
  }
}

// Lifecycle Recovery check on startup
chrome.runtime.onStartup.addListener(restoreSessionState);
chrome.runtime.onInstalled.addListener(restoreSessionState);

async function restoreSessionState() {
  await loadEnvIntoStorage();
  chrome.storage.session.get(['captureActive', 'activeTabId'], async (session) => {
    if (session.captureActive && session.activeTabId) {
      console.log("Restoring active capture session for tab:", session.activeTabId);
      // Wait a moment and restart capture
      setTimeout(() => {
        handleStartCapture(session.activeTabId, () => {});
      }, 1000);
    }
  });
}

// Storage Listener to sync configurations to offscreen document dynamically
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && isRecording) {
    chrome.storage.local.get(['apiProvider', 'groqApiKey', 'geminiApiKey', 'openaiApiKey', 'silenceThreshold'], (settings) => {
      const provider = settings.apiProvider || 'groq';
      let key = '';
      if (provider === 'groq') key = settings.groqApiKey || '';
      else if (provider === 'gemini') key = settings.geminiApiKey || '';
      else key = settings.openaiApiKey || '';
      
      chrome.runtime.sendMessage({
        type: 'UPDATE_CONFIG',
        apiProvider: provider,
        apiKey: key,
        groqApiKey: settings.groqApiKey || '',
        geminiApiKey: settings.geminiApiKey || '',
        openaiApiKey: settings.openaiApiKey || '',
        silenceThreshold: settings.silenceThreshold !== undefined ? settings.silenceThreshold : 0.015,
        speedMode: speedMode
      }).catch(() => {});
    });
  }
});

// Dynamic Rate Limit Adjuster
function handleRateLimitHit(message) {
  const retryAfter = (message && message.retryAfter) || 15;
  console.warn(`API Rate Limit (429) hit. Pacing paused for ${retryAfter}s.`);
  
  // Notify content script to display cooldown badge
  if (activeTabId) {
    chrome.tabs.sendMessage(activeTabId, { 
      type: 'UPDATE_STATUS_BADGE', 
      statusText: `⏳ COOLDOWN (${retryAfter}s)` 
    }).catch(() => {});
  }
  
  if (rateLimitTimer) clearTimeout(rateLimitTimer);
  rateLimitTimer = setTimeout(() => {
    if (activeTabId) {
      chrome.tabs.sendMessage(activeTabId, { 
        type: 'UPDATE_STATUS_BADGE', 
        statusText: '🔴 LIVE CAPTURING AUDIO' 
      }).catch(() => {});
    }
  }, retryAfter * 1000);
}
