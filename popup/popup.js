// Cache elements
const statusContainer = document.getElementById('status-container');
const statusText = document.getElementById('status-text');
const toggleBtn = document.getElementById('toggle-capture-btn');
const btnText = toggleBtn.querySelector('.btn-text');
const statDuration = document.getElementById('stat-duration');
const statCost = document.getElementById('stat-cost');
const openOptionsBtn = document.getElementById('open-options-btn');

// Request initial state from background
function updateUI() {
  chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (response) => {
    if (chrome.runtime.lastError) {
      console.warn("Could not fetch status from background worker:", chrome.runtime.lastError.message);
      return;
    }
    
    if (response) {
      const { isRecording, durationText, costText, error } = response;
      
      if (isRecording) {
        statusContainer.className = 'status-box recording';
        statusText.textContent = '🔴 Live Capturing Audio';
        toggleBtn.className = 'primary-btn recording';
        btnText.textContent = 'Stop Capture';
      } else {
        statusContainer.className = error ? 'status-box error' : 'status-box idle';
        statusText.textContent = error ? `Error: ${error}` : 'Ready to Learn';
        toggleBtn.className = 'primary-btn';
        btnText.textContent = 'Start Capture';
      }
      
      statDuration.textContent = durationText || '0h 0m';
      statCost.textContent = costText || '0 ($0.00)';
    }
  });
}

// Set click handlers
toggleBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (statusResponse) => {
    const isRecording = statusResponse && statusResponse.isRecording;
    
    if (!isRecording) {
      // Find active tab to capture
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const activeTab = tabs[0];
        if (!activeTab) return;
        
        chrome.runtime.sendMessage({
          type: 'START_CAPTURE',
          tabId: activeTab.id
        }, (response) => {
          if (response && response.error) {
            statusContainer.className = 'status-box error';
            statusText.textContent = response.error;
            if (response.error.includes("API key")) {
              setTimeout(() => chrome.runtime.openOptionsPage(), 1500);
            }
          }
          updateUI();
        });
      });
    } else {
      chrome.runtime.sendMessage({ type: 'STOP_CAPTURE' }, () => {
        updateUI();
      });
    }
  });
});

openOptionsBtn.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// Periodically update UI stats
updateUI();
setInterval(updateUI, 1000);
