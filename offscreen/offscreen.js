// Global states
let audioContext = null;
let mediaStream = null;
let mediaRecorder = null;
let jaTokenizer = null;
let tabId = null;

let isRecording = false;
let isStoppingToSlice = false;
let chunks = [];

// Audio slice state
let chunkStartTime = 0;
let elapsedRecordingTime = 0;
let accumulatedSilenceTime = 0;
let checkInterval = null;

// Settings (default values, passed from background settings)
let silenceThreshold = 0.015;
let apiProvider = 'groq';
let apiKey = '';

let silenceDurationLimit = 150; // ms (Ultra-fast real-time 0.15s pause to slice)
let minChunkDuration = 550;    // ms (Fast speech slice 0.55s)
let maxChunkDuration = 2800;   // ms (Maximum 2.8s chunk to prevent 429 rate limit)
let noiseFloor = 0.008;        // Adaptive ambient noise floor tracking

// Rate limiter spacing to prevent hitting Groq 20 RPM limit
let lastApiRequestTime = 0;
const MIN_API_INTERVAL = 2600; // ms (Guarantees max ~22 requests per minute)

// Contextual prompt buffer for Whisper API acceleration
let lastPromptContext = '';

// Initialize local N1-N5 dictionary
let localDict = {};
fetch(chrome.runtime.getURL('dict/jlpt_dict.json'))
  .then(res => res.json())
  .then(data => {
    localDict = data;
    console.log("Local N1-N5 JLPT Dictionary loaded successfully.");
  })
  .catch(err => console.error("Failed to load local dictionary:", err));

// Initialize Kuromoji Tokenizer on load
kuromoji.builder({ dicPath: '../lib/dict/' }).build((err, tokenizer) => {
  const statusDiv = document.getElementById('status');
  if (err) {
    console.error("Failed to initialize Kuromoji:", err);
    statusDiv.textContent = "Error: Failed to load Kuromoji dicts.";
  } else {
    jaTokenizer = tokenizer;
    statusDiv.textContent = "Kuromoji Tokenizer Loaded. Ready for audio capture.";
    console.log("Kuromoji tokenizer successfully initialized in offscreen document.");
  }
});

// Message Listener
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'INIT_CAPTURE') {
    tabId = message.tabId;
    if (message.apiProvider) apiProvider = message.apiProvider;
    if (message.apiKey) apiKey = message.apiKey;
    if (message.silenceThreshold !== undefined) silenceThreshold = message.silenceThreshold;
    
    if (message.speedMode === 'slow') {
      silenceDurationLimit = 400;
      minChunkDuration = 1800;
      maxChunkDuration = 4500;
    } else { // fast (ultra real-time sub-second)
      silenceDurationLimit = 150;
      minChunkDuration = 550;
      maxChunkDuration = 2800;
    }
    
    startCapture(message.streamId);
  } else if (message.type === 'UPDATE_CONFIG') {
    if (message.apiProvider) apiProvider = message.apiProvider;
    if (message.apiKey) apiKey = message.apiKey;
    if (message.silenceThreshold !== undefined) silenceThreshold = message.silenceThreshold;
    
    if (message.speedMode === 'slow') {
      silenceDurationLimit = 400;
      minChunkDuration = 1800;
      maxChunkDuration = 4500;
    } else { // fast
      silenceDurationLimit = 150;
      minChunkDuration = 550;
      maxChunkDuration = 2800;
    }
  }
});

// START CAPTURE
async function startCapture(streamId) {
  try {
    // 1. Get UserMedia tab audio stream
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      },
      video: false
    });

    // 2. Setup AudioContext and route to speaker destination
    audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(mediaStream);
    source.connect(audioContext.destination);

    // 3. Setup volume analyser for silence detection
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);

    const bufferLength = analyser.fftSize;
    const dataArray = new Float32Array(bufferLength);
    let peakRmsInChunk = 0; // Tracks loudest frame in current chunk to filter out silence hallucinations

    // 4. Setup MediaRecorder
    chunks = [];
    mediaRecorder = new MediaRecorder(mediaStream, { mimeType: 'audio/webm' });
    
    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        chunks.push(e.data);
      }
    };

    mediaRecorder.onstop = async () => {
      const blob = new Blob(chunks, { type: 'audio/webm' });
      chunks = [];

      const startTime = chunkStartTime;
      const endTime = startTime + (elapsedRecordingTime / 1000);
      
      const currentPeak = peakRmsInChunk;
      peakRmsInChunk = 0; // reset for next chunk

      // Start recording the next chunk immediately to prevent gaps
      if (isRecording) {
        mediaRecorder.start();
        elapsedRecordingTime = 0;
        accumulatedSilenceTime = 0;
        isStoppingToSlice = false;

        // Fetch current video time asynchronously for the next chunk's start point
        getVideoTime((vTime) => {
          chunkStartTime = vTime;
        });
      }

      // Process and transcribe completed chunk only if it contains active speech sound!
      if (currentPeak >= 0.012 || currentPeak > noiseFloor * 1.35) {
        processAudioChunk(blob, startTime, endTime);
      } else {
        console.log(`Skipped silent chunk (Peak RMS: ${currentPeak.toFixed(4)}, noise floor: ${noiseFloor.toFixed(4)})`);
      }
    };

    // Start Recording Session
    isRecording = true;
    isStoppingToSlice = false;
    
    getVideoTime((vTime) => {
      chunkStartTime = vTime;
      mediaRecorder.start();
      elapsedRecordingTime = 0;
      accumulatedSilenceTime = 0;

      // Start rapid adaptive voice activity checking loop (every 50ms)
      checkInterval = setInterval(() => {
        if (!isRecording || isStoppingToSlice) return;

        // Get time domain data
        analyser.getFloatTimeDomainData(dataArray);
        
        // Calculate Root Mean Square (RMS) volume
        let sumSquares = 0;
        for (let i = 0; i < bufferLength; i++) {
          sumSquares += dataArray[i] * dataArray[i];
        }
        const rms = Math.sqrt(sumSquares / bufferLength);

        // Smoothly adapt the noise floor to ambient background sound/music
        noiseFloor = Math.min(noiseFloor * 0.992 + rms * 0.008, Math.max(0.002, rms));

        // Keep track of the peak volume in this chunk
        if (rms > peakRmsInChunk) {
          peakRmsInChunk = rms;
        }

        // Adaptive Speech Pause Detection:
        // Triggered when current RMS drops near ambient noise floor
        // OR when voice drops by >60% compared to the peak speech level in this chunk
        const isPause = (rms <= noiseFloor * 1.35 + 0.005) || (peakRmsInChunk > 0.022 && rms < peakRmsInChunk * 0.38);

        if (isPause) {
          accumulatedSilenceTime += 50;
        } else {
          accumulatedSilenceTime = Math.max(0, accumulatedSilenceTime - 25);
        }

        elapsedRecordingTime += 50;

        const now = Date.now();
        const timeSinceLastReq = now - lastApiRequestTime;

        // Trigger slice check (rate-limited pacing to prevent Groq 429)
        if (elapsedRecordingTime >= maxChunkDuration) {
          sliceChunk();
        } else if (elapsedRecordingTime >= minChunkDuration && accumulatedSilenceTime >= silenceDurationLimit) {
          if (timeSinceLastReq >= MIN_API_INTERVAL) {
            sliceChunk();
          }
        }
      }, 50);
    });

  } catch (err) {
    console.error("Failed to capture tab audio:", err);
    chrome.runtime.sendMessage({
      type: 'TOKENIZED_RESULT',
      tokens: [{ surface: `Capture Error: ${err.name} - ${err.message}`, pos: 'Unknown', reading: '', baseForm: '' }],
      text: `Capture Error: ${err.name} - ${err.message}`,
      startTime: 0,
      endTime: 0
    });
  }
}

// Slice chunk helper
function sliceChunk() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    isStoppingToSlice = true;
    mediaRecorder.stop();
  }
}

// Fetch active video time via background proxy
function getVideoTime(callback) {
  chrome.runtime.sendMessage({ type: 'QUERY_VIDEO_TIME' }, (response) => {
    if (chrome.runtime.lastError || !response || response.currentTime === undefined) {
      // Fallback to local clock relative offset
      callback(Date.now() / 1000);
    } else {
      callback(response.currentTime);
    }
  });
}

// Process and transcribe audio chunk directly from offscreen
function processAudioChunk(blob, startTime, endTime) {
  if (!apiKey) {
    sendErrorSubtitle("Missing API Key. Configure settings.", startTime, endTime);
    return;
  }

  lastApiRequestTime = Date.now();

  (async () => {
    try {
      let text = '';
      const formData = new FormData();
      formData.append('file', blob, 'audio.webm');
      formData.append('language', 'ja');
      if (lastPromptContext) {
        formData.append('prompt', lastPromptContext.slice(-120));
      }

      formData.append('temperature', '0.0');

      if (apiProvider === 'groq') {
        formData.append('model', 'whisper-large-v3-turbo');
        const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`
          },
          body: formData
        });
        if (!response.ok) {
          const errText = await response.text();
          if (response.status === 429) {
            chrome.runtime.sendMessage({ type: 'RATE_LIMIT_HIT' }).catch(() => {});
          }
          throw new Error(`Groq API error (${response.status}): ${errText}`);
        }
        const data = await response.json();
        text = data.text || '';
      } else {
        formData.append('model', 'whisper-1');
        const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`
          },
          body: formData
        });
        if (!response.ok) {
          const errText = await response.text();
          if (response.status === 429) {
            chrome.runtime.sendMessage({ type: 'RATE_LIMIT_HIT' }).catch(() => {});
          }
          throw new Error(`OpenAI API error (${response.status}): ${errText}`);
        }
        const data = await response.json();
        text = data.text || '';
      }

      text = text.trim();
      
      // Filter out common Whisper silence/noise hallucinations
      const hallucinations = [
        "ご視聴ありがとうございました",
        "ご視聴ありがとうございました。",
        "視聴ありがとうございました",
        "視聴ありがとうございました。",
        "チャンネル登録よろしくお願いします",
        "チャンネル登録よろしくお願いします。",
        "ご視聴いただきありがとうございました",
        "ご視聴いただきありがとうございました。"
      ];
      
      if (hallucinations.includes(text)) {
        console.log(`Filtered out Whisper hallucination: "${text}"`);
        return;
      }
      
      if (text) {
        lastPromptContext = (lastPromptContext + ' ' + text).slice(-300);
        chrome.runtime.sendMessage({
          type: 'UPDATE_STATS',
          durationSec: (endTime - startTime),
          provider: apiProvider
        });
        tokenizeAndForward(text, startTime, endTime);
      }
    } catch (err) {
      console.error("Transcription failed in offscreen document:", err);
      sendErrorSubtitle(err.message, startTime, endTime);
    }
  })();
}

// Send error message as a subtitle token
function sendErrorSubtitle(errorMsg, startTime, endTime) {
  chrome.runtime.sendMessage({
    type: 'TOKENIZED_RESULT',
    tokens: [{ surface: `Error: ${errorMsg}`, pos: 'Unknown', reading: '', baseForm: '', isContentWord: false, isParticle: false }],
    text: `Error: ${errorMsg}`,
    startTime,
    endTime
  });
}

// Merge auxiliary inflections & particles into composite head words
function mergeMorphologicalTokens(rawTokens) {
  const merged = [];
  let i = 0;

  while (i < rawTokens.length) {
    const cur = rawTokens[i];

    // 1. Verbs (動詞) & Adjectives (形容詞): Recombine conjugated stems with auxiliaries (助動詞) & conjunctive particles (接続助詞: て/で)
    if (cur.pos === '動詞' || cur.pos === '形容詞') {
      let compoundSurface = cur.surface_form;
      let compoundReading = cur.reading || cur.surface_form;
      const baseLemma = cur.basic_form && cur.basic_form !== '*' ? cur.basic_form : cur.surface_form;

      while (i + 1 < rawTokens.length) {
        const next = rawTokens[i + 1];
        const isAux = (next.pos === '助動詞');
        const isConj = (next.pos === '助詞' && (next.pos_detail_1 === '接続助詞' || next.surface_form === 'て' || next.surface_form === 'で'));
        const isSuffix = (next.pos === '名詞' && next.pos_detail_1 === '接尾');

        if (isAux || isConj || isSuffix) {
          compoundSurface += next.surface_form;
          compoundReading += (next.reading || next.surface_form);
          i++;
        } else {
          break;
        }
      }

      merged.push({
        surface: compoundSurface,
        reading: compoundReading,
        baseForm: baseLemma,
        pos: cur.pos,
        isContentWord: true,
        isParticle: false
      });
      i++;
      continue;
    }

    // 2. Prefix + Noun (接頭詞 + 名詞): e.g. お + 酒 -> お酒, ご + 飯 -> ご飯
    if (cur.pos === '接頭詞' && i + 1 < rawTokens.length && rawTokens[i + 1].pos === '名詞') {
      const next = rawTokens[i + 1];
      merged.push({
        surface: cur.surface_form + next.surface_form,
        reading: (cur.reading || cur.surface_form) + (next.reading || next.surface_form),
        baseForm: next.basic_form && next.basic_form !== '*' ? next.basic_form : next.surface_form,
        pos: '名詞',
        isContentWord: true,
        isParticle: false
      });
      i += 2;
      continue;
    }

    // 3. Particles (助詞): e.g. を, は, が, に, で, へ, と, から, まで, より, も, の, ね, よ
    if (cur.pos === '助詞') {
      merged.push({
        surface: cur.surface_form,
        reading: cur.reading || cur.surface_form,
        baseForm: cur.surface_form,
        pos: cur.pos,
        isContentWord: false,
        isParticle: true
      });
      i++;
      continue;
    }

    // 4. Symbols (記号)
    if (cur.pos === '記号' || cur.pos === 'Unknown') {
      merged.push({
        surface: cur.surface_form,
        reading: '',
        baseForm: cur.surface_form,
        pos: cur.pos,
        isContentWord: false,
        isParticle: false
      });
      i++;
      continue;
    }

    // 5. General content words (名詞, 副詞, 連体詞, etc.)
    merged.push({
      surface: cur.surface_form,
      reading: cur.reading || cur.surface_form,
      baseForm: cur.basic_form && cur.basic_form !== '*' ? cur.basic_form : cur.surface_form,
      pos: cur.pos,
      isContentWord: true,
      isParticle: false
    });
    i++;
  }

  return merged;
}

// Tokenize using Kuromoji and forward to background
function tokenizeAndForward(text, startTime, endTime) {
  if (!jaTokenizer) {
    console.warn("Kuromoji tokenizer not ready yet. Sending raw text.");
    chrome.runtime.sendMessage({
      type: 'TOKENIZED_RESULT',
      tokens: [{ surface: text, pos: 'Unknown', reading: '', baseForm: text, isContentWord: false, isParticle: false }],
      text,
      startTime,
      endTime
    });
    return;
  }

  try {
    const rawTokens = jaTokenizer.tokenize(text);
    const mergedList = mergeMorphologicalTokens(rawTokens);

    const parsedTokens = mergedList.map(t => {
      let jlpt = null;
      let meaning = '';

      if (t.isContentWord) {
        const entry = localDict[t.surface] || localDict[t.baseForm];
        if (entry) {
          jlpt = entry.level;
          meaning = entry.meaning;
        }
      }

      return {
        surface: t.surface,
        pos: t.pos,
        reading: t.reading,
        baseForm: t.baseForm,
        jlpt: jlpt,
        meaning: meaning,
        isContentWord: t.isContentWord,
        isParticle: t.isParticle
      };
    });

    // Send tokenized results back to background
    chrome.runtime.sendMessage({
      type: 'TOKENIZED_RESULT',
      tokens: parsedTokens,
      text,
      startTime,
      endTime
    });
  } catch (err) {
    console.error("Tokenization failed:", err);
  }
}

// Cleanup on page unload/close
window.addEventListener('beforeunload', () => {
  isRecording = false;
  if (checkInterval) clearInterval(checkInterval);
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
  }
  if (audioContext) {
    audioContext.close();
  }
});

// Notify background that we are loaded and ready to receive stream config
chrome.runtime.sendMessage({ type: 'OFFSCREEN_READY' }).catch(() => {});
