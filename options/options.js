// Tab Switching Logic
const navItems = document.querySelectorAll('.nav-item');
const tabPanes = document.querySelectorAll('.tab-pane');

navItems.forEach(item => {
  item.addEventListener('click', () => {
    navItems.forEach(nav => nav.classList.remove('active'));
    tabPanes.forEach(pane => pane.classList.remove('active'));

    item.classList.add('active');
    const tabName = item.getAttribute('data-tab');
    document.getElementById(`tab-${tabName}`).classList.add('active');
  });
});

// Cache elements
const providerSelect = document.getElementById('api-provider');
const groqKeyGroup = document.getElementById('groq-key-group');
const geminiKeyGroup = document.getElementById('gemini-key-group');
const openaiKeyGroup = document.getElementById('openai-key-group');
const groqKeyInput = document.getElementById('groq-api-key');
const geminiKeyInput = document.getElementById('gemini-api-key');
const openaiKeyInput = document.getElementById('openai-api-key');
const saveApiBtn = document.getElementById('save-api-btn');
const saveStatus = document.getElementById('save-status');

const ankiEnabledCheckbox = document.getElementById('anki-enabled');
const ankiSettingsBox = document.getElementById('anki-settings');
const ankiDeckInput = document.getElementById('anki-deck');
const saveAnkiBtn = document.getElementById('save-anki-btn');
const testAnkiBtn = document.getElementById('test-anki-btn');
const ankiStatus = document.getElementById('anki-status');

const ephemeralCheckbox = document.getElementById('ephemeral-mode');
const savePrivacyBtn = document.getElementById('save-privacy-btn');
const resetStatsBtn = document.getElementById('reset-stats-btn');

const optDuration = document.getElementById('stat-opt-duration');
const optRequests = document.getElementById('stat-opt-requests');
const optCost = document.getElementById('stat-opt-cost');

// Provider toggle
providerSelect.addEventListener('change', () => {
  groqKeyGroup.classList.toggle('hidden', providerSelect.value !== 'groq');
  geminiKeyGroup.classList.toggle('hidden', providerSelect.value !== 'gemini');
  openaiKeyGroup.classList.toggle('hidden', providerSelect.value !== 'openai');
});

// Anki toggle
ankiEnabledCheckbox.addEventListener('change', () => {
  if (ankiEnabledCheckbox.checked) {
    ankiSettingsBox.classList.remove('hidden');
  } else {
    ankiSettingsBox.classList.add('hidden');
  }
});

// Load Settings
function loadSettings() {
  chrome.storage.local.get([
    'apiProvider',
    'groqApiKey',
    'geminiApiKey',
    'openaiApiKey',
    'ankiEnabled',
    'ankiDeck',
    'ephemeralMode',
    'statDurationMinutes',
    'statRequestsCount',
    'statTotalCost'
  ], (settings) => {
    // API
    providerSelect.value = settings.apiProvider || 'groq';
    providerSelect.dispatchEvent(new Event('change'));
    groqKeyInput.value = settings.groqApiKey || '';
    geminiKeyInput.value = settings.geminiApiKey || '';
    openaiKeyInput.value = settings.openaiApiKey || '';

    // Anki
    ankiEnabledCheckbox.checked = settings.ankiEnabled || false;
    ankiEnabledCheckbox.dispatchEvent(new Event('change'));
    ankiDeckInput.value = settings.ankiDeck || 'Rikimashou! Immersion';

    // Privacy
    ephemeralCheckbox.checked = settings.ephemeralMode || false;

    // Stats
    const durMins = settings.statDurationMinutes || 0;
    const hrs = Math.floor(durMins / 60);
    const mins = Math.floor(durMins % 60);
    optDuration.textContent = `${hrs}h ${mins}m`;
    optRequests.textContent = settings.statRequestsCount || 0;
    optCost.textContent = `$${(settings.statTotalCost || 0).toFixed(4)}`;

    // Update mined vocab count
    chrome.storage.local.get(['savedVocab'], (data) => {
      const vocabCount = Object.keys(data.savedVocab || {}).length;
      document.getElementById('mined-count-text').textContent = `You have ${vocabCount} mined vocabulary words saved locally.`;
    });
  });
}

// Save API Keys
saveApiBtn.addEventListener('click', () => {
  const settings = {
    apiProvider: providerSelect.value,
    groqApiKey: groqKeyInput.value.trim(),
    geminiApiKey: geminiKeyInput.value.trim(),
    openaiApiKey: openaiKeyInput.value.trim()
  };

  chrome.storage.local.set(settings, () => {
    showStatus(saveStatus, 'API settings saved successfully!');
  });
});

// Save Anki
saveAnkiBtn.addEventListener('click', () => {
  const settings = {
    ankiEnabled: ankiEnabledCheckbox.checked,
    ankiDeck: ankiDeckInput.value.trim()
  };

  chrome.storage.local.set(settings, () => {
    showStatus(ankiStatus, 'Anki settings saved!');
  });
});

// Test Anki
testAnkiBtn.addEventListener('click', () => {
  ankiStatus.textContent = 'Connecting...';
  ankiStatus.style.color = '#7c4dff';

  fetch('http://localhost:8765', {
    method: 'POST',
    body: JSON.stringify({ action: 'deckNames', version: 6 })
  })
  .then(res => res.json())
  .then(data => {
    if (data && data.result) {
      ankiStatus.textContent = 'Connected! Decks found: ' + data.result.length;
      ankiStatus.style.color = '#00e676';
    } else {
      ankiStatus.textContent = 'Failed: Unexpected response from AnkiConnect';
      ankiStatus.style.color = '#ff1744';
    }
  })
  .catch(err => {
    ankiStatus.textContent = 'Failed: Anki is not open or AnkiConnect is missing.';
    ankiStatus.style.color = '#ff1744';
  });
});

// Save Privacy
savePrivacyBtn.addEventListener('click', () => {
  const settings = {
    ephemeralMode: ephemeralCheckbox.checked
  };

  chrome.storage.local.set(settings, () => {
    showStatus(saveStatus, 'Privacy configuration saved!');
  });
});

// Reset Stats
resetStatsBtn.addEventListener('click', () => {
  if (confirm('Are you sure you want to reset all usage statistics?')) {
    chrome.storage.local.set({
      statDurationMinutes: 0,
      statRequestsCount: 0,
      statTotalCost: 0
    }, () => {
      loadSettings();
    });
  }
});

// Download CSV
document.getElementById('download-csv-btn').addEventListener('click', () => {
  chrome.storage.local.get(['savedVocab'], (data) => {
    const vocab = data.savedVocab || {};
    const items = Object.values(vocab);
    if (items.length === 0) {
      alert("No vocabulary words saved yet!");
      return;
    }
    
    let csvContent = "Word,Reading,Meaning,Sentence,JLPT Level,Source URL,Timestamp\n";
    items.forEach(v => {
      const row = [
        `"${(v.word || '').replace(/"/g, '""')}"`,
        `"${(v.reading || '').replace(/"/g, '""')}"`,
        `"${(v.meaning || '').replace(/"/g, '""')}"`,
        `"${(v.sentence || '').replace(/"/g, '""')}"`,
        v.level ? `N${v.level}` : '',
        `"${(v.url || '').replace(/"/g, '""')}"`,
        v.timestamp || ''
      ].join(',');
      csvContent += row + "\n";
    });

     const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", "rikimashou_mined_vocabulary.csv");
    document.body.appendChild(link);
    link.click();
    link.remove();
  });
});

// Clear Saved Vocabulary
document.getElementById('clear-vocab-btn').addEventListener('click', () => {
  if (confirm("Are you sure you want to delete ALL local saved vocabulary? This cannot be undone.")) {
    chrome.storage.local.set({ savedVocab: {} }, () => {
      loadSettings();
    });
  }
});

function showStatus(elem, text) {
  elem.textContent = text;
  elem.style.color = '#00e676';
  setTimeout(() => {
    elem.textContent = '';
  }, 3000);
}

// Init
document.addEventListener('DOMContentLoaded', loadSettings);
