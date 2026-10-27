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
let groqApiKey = '';
let geminiApiKey = '';
let openaiApiKey = '';
let groqApiKeys = [];
let groqKeyIndex = 0;
let groqCooldownUntil = 0;

// Sub-second Real-Time VAD parameters
let silenceDurationLimit = 160; // ms (Ultra-fast real-time 0.16s pause detection)
let minChunkDuration = 450;    // ms (Fast speech slice 0.45s)
let maxChunkDuration = 2000;   // ms (Maximum 2.0s chunk for continuous speech)
let noiseFloor = 0.008;        // Adaptive ambient noise floor tracking

// Rolling 60-second sliding window for Groq rate limiter
let groqTimestamps = [];
const GROQ_WINDOW_MS = 60000;
const GROQ_MAX_RPM_PER_KEY = 19; // Safe margin below Groq 20 RPM limit

function setApiKeys(config) {
  if (config.apiProvider) apiProvider = config.apiProvider;
  if (config.apiKey) apiKey = config.apiKey;
  if (config.groqApiKey) {
    groqApiKey = config.groqApiKey;
  } else if (apiProvider === 'groq' && apiKey) {
    groqApiKey = apiKey;
  }
  if (groqApiKey) {
    groqApiKeys = groqApiKey.split(',').map(s => s.trim()).filter(Boolean);
  }
  if (config.geminiApiKey) geminiApiKey = config.geminiApiKey;
  if (config.openaiApiKey) openaiApiKey = config.openaiApiKey;
}

function getNextGroqKey() {
  if (groqApiKeys.length === 0) return groqApiKey || apiKey;
  const key = groqApiKeys[groqKeyIndex % groqApiKeys.length];
  groqKeyIndex++;
  return key;
}

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
    setApiKeys(message);
    if (message.silenceThreshold !== undefined) silenceThreshold = message.silenceThreshold;
    
    if (message.speedMode === 'slow') {
      silenceDurationLimit = 350;
      minChunkDuration = 1200;
      maxChunkDuration = 3500;
    } else { // fast (ultra real-time sub-second)
      silenceDurationLimit = 160;
      minChunkDuration = 450;
      maxChunkDuration = 2000;
    }
    
    startCapture(message.streamId);
  } else if (message.type === 'UPDATE_CONFIG') {
    setApiKeys(message);
    if (message.silenceThreshold !== undefined) silenceThreshold = message.silenceThreshold;
    
    if (message.speedMode === 'slow') {
      silenceDurationLimit = 350;
      minChunkDuration = 1200;
      maxChunkDuration = 3500;
    } else { // fast
      silenceDurationLimit = 160;
      minChunkDuration = 450;
      maxChunkDuration = 2000;
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
      const hasSpeech = (currentPeak >= 0.020 && currentPeak > noiseFloor * 1.45) || (currentPeak >= silenceThreshold * 1.5);
      if (hasSpeech) {
        processAudioChunk(blob, startTime, endTime);
      } else {
        console.log(`Skipped non-speech chunk (Peak RMS: ${currentPeak.toFixed(4)}, noise floor: ${noiseFloor.toFixed(4)})`);
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

        // Ultra-low latency speech pause detection:
        // Slices immediately when a speaker pauses (>= 160ms) after an utterance (>= 450ms)
        const isNaturalPause = (elapsedRecordingTime >= minChunkDuration && accumulatedSilenceTime >= silenceDurationLimit);
        // Or if speech is continuous for >= 2000ms
        const isMaxDuration = (elapsedRecordingTime >= maxChunkDuration);

        if (isNaturalPause || isMaxDuration) {
          sliceChunk();
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

// Convert AudioBuffer to 16kHz mono WAV for Google Gemini API
function audioBufferToWav(audioBuffer, targetSampleRate = 16000) {
  const sourceChannelData = audioBuffer.getChannelData(0);
  const sourceSampleRate = audioBuffer.sampleRate;
  const sampleRateRatio = sourceSampleRate / targetSampleRate;
  const targetLength = Math.round(sourceChannelData.length / sampleRateRatio);
  const resampled = new Float32Array(targetLength);

  for (let i = 0; i < targetLength; i++) {
    const originIndex = i * sampleRateRatio;
    const indexFloor = Math.floor(originIndex);
    const indexCeil = Math.min(sourceChannelData.length - 1, Math.ceil(originIndex));
    const interpolation = originIndex - indexFloor;
    resampled[i] = sourceChannelData[indexFloor] * (1 - interpolation) + sourceChannelData[indexCeil] * interpolation;
  }

  const buffer = new ArrayBuffer(44 + resampled.length * 2);
  const view = new DataView(buffer);

  function writeString(view, offset, string) {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  }

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + resampled.length * 2, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, targetSampleRate, true);
  view.setUint32(28, targetSampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, 'data');
  view.setUint32(40, resampled.length * 2, true);

  let offset = 44;
  for (let i = 0; i < resampled.length; i++) {
    const s = Math.max(-1, Math.min(1, resampled[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    offset += 2;
  }

  return buffer;
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// Transcribe audio chunk with Google Gemini 3.5 Transcribe
async function transcribeGemini(blob, startTime, endTime) {
  const gKey = geminiApiKey || apiKey;
  if (!gKey) {
    throw new Error("Missing Gemini API Key. Configure settings or .env.");
  }

  const arrayBuf = await blob.arrayBuffer();
  const audioBuf = await audioContext.decodeAudioData(arrayBuf);
  const wavBuffer = audioBufferToWav(audioBuf, 16000);
  const base64Audio = arrayBufferToBase64(wavBuffer);

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-transcribe:generateContent?key=${gKey}`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { inline_data: { mime_type: 'audio/wav', data: base64Audio } },
          { text: 'Transcribe the spoken Japanese in this audio into Japanese text. Output ONLY the exact transcription in Japanese Kanji/Kana. If silence or music with no speech, reply with nothing.' }
        ]
      }],
      generationConfig: {
        temperature: 0.0,
        thinkingConfig: {
          thinkingBudget: 0
        }
      }
    })
  });

  if (!response.ok) {
    // If dedicated transcribe model is busy or returns non-200, fallback seamlessly to gemini-3.5-flash
    if (response.status === 404 || response.status === 503) {
      console.warn("Transcribe model busy, failing over to gemini-3.5-flash...");
      const fbEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${gKey}`;
      const fbResponse = await fetch(fbEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { inline_data: { mime_type: 'audio/wav', data: base64Audio } },
              { text: 'Transcribe the spoken Japanese audio into Japanese text. Output ONLY the exact Japanese transcription. Do not translate. If silence, output empty string.' }
            ]
          }],
          generationConfig: {
            temperature: 0.0,
            thinkingConfig: {
              thinkingBudget: 0
            }
          }
        })
      });
      if (fbResponse.ok) {
        const fbData = await fbResponse.json();
        return fbData.candidates?.[0]?.content?.parts?.[0]?.text || '';
      }
    }
    const errText = await response.text();
    throw new Error(`Gemini API error (${response.status}): ${errText}`);
  }

  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// Process and transcribe audio chunk directly from offscreen
function processAudioChunk(blob, startTime, endTime) {
  (async () => {
    try {
      let text = '';
      const now = Date.now();

      // Clean up Groq timestamps older than 60s
      groqTimestamps = groqTimestamps.filter(t => (now - t) < GROQ_WINDOW_MS);
      const totalAllowedGroq = Math.max(1, groqApiKeys.length) * GROQ_MAX_RPM_PER_KEY;
      const groqQuotaAvailable = (groqTimestamps.length < totalAllowedGroq) && (now > groqCooldownUntil);

      let useGemini = (apiProvider === 'gemini');

      // If Groq is the active provider but saturated its 19/20 limit in the current rolling minute:
      if (apiProvider === 'groq' && !groqQuotaAvailable) {
        if (geminiApiKey) {
          console.log(`Groq quota saturated (${groqTimestamps.length}/${totalAllowedGroq} in 60s). Seamlessly routing chunk to Gemini!`);
          useGemini = true;
        } else {
          // If no Gemini key, safely wait the remaining milliseconds until the oldest request clears
          const oldest = groqTimestamps[0] || (now - GROQ_WINDOW_MS);
          const waitMs = Math.max(50, Math.min(3000, GROQ_WINDOW_MS - (now - oldest) + 50));
          await new Promise(r => setTimeout(r, waitMs));
        }
      }

      if (useGemini) {
        text = await transcribeGemini(blob, startTime, endTime);
        handleTranscribedText(text, startTime, endTime, 'gemini');
        return;
      }

      if (apiProvider === 'groq') {
        const activeGroqKey = getNextGroqKey();
        if (!activeGroqKey) {
          sendErrorSubtitle("Missing Groq API Key. Configure settings or .env.", startTime, endTime);
          return;
        }

        groqTimestamps.push(Date.now());

        const formData = new FormData();
        formData.append('file', blob, 'audio.webm');
        formData.append('language', 'ja');
        formData.append('model', 'whisper-large-v3-turbo');
        formData.append('temperature', '0.0');
        formData.append('response_format', 'json');
        if (lastPromptContext) {
          formData.append('prompt', lastPromptContext.slice(-120));
        }

        const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${activeGroqKey}`
          },
          body: formData
        });

        if (!response.ok) {
          if (response.status === 429) {
            const retryAfter = parseInt(response.headers.get('retry-after') || '20', 10);
            groqCooldownUntil = Date.now() + (retryAfter * 1000);
            chrome.runtime.sendMessage({ type: 'RATE_LIMIT_HIT', retryAfter }).catch(() => {});

            // Seamless Instant Failover to Gemini:
            if (geminiApiKey) {
              console.log("Groq rate limit hit. Seamlessly transcribing chunk with Gemini API!");
              try {
                const geminiText = await transcribeGemini(blob, startTime, endTime);
                handleTranscribedText(geminiText, startTime, endTime, 'gemini');
              } catch (gErr) {
                console.warn("Gemini failover also encountered an error:", gErr.message);
              }
            }
            return; // Never throw raw 429 JSON onto video screen!
          }

          const errText = await response.text();
          throw new Error(`Groq API error (${response.status}): ${errText}`);
        }

        const data = await response.json();
        text = data.text || '';
        handleTranscribedText(text, startTime, endTime, 'groq');
        return;
      }

      if (apiProvider === 'openai') {
        const activeKey = openaiApiKey || apiKey;
        if (!activeKey) {
          sendErrorSubtitle("Missing OpenAI API Key. Configure settings or .env.", startTime, endTime);
          return;
        }

        const formData = new FormData();
        formData.append('file', blob, 'audio.webm');
        formData.append('language', 'ja');
        formData.append('model', 'whisper-1');
        formData.append('temperature', '0.0');
        if (lastPromptContext) {
          formData.append('prompt', lastPromptContext.slice(-120));
        }

        const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${activeKey}`
          },
          body: formData
        });

        if (!response.ok) {
          const errText = await response.text();
          if (response.status === 429) {
            chrome.runtime.sendMessage({ type: 'RATE_LIMIT_HIT', retryAfter: 20 }).catch(() => {});
            return;
          }
          throw new Error(`OpenAI API error (${response.status}): ${errText}`);
        }

        const data = await response.json();
        text = data.text || '';
        handleTranscribedText(text, startTime, endTime, 'openai');
      }
    } catch (err) {
      console.error("Transcription failed in offscreen document:", err);
      if (!err.message.includes('429') && !err.message.includes('Rate limit')) {
        sendErrorSubtitle(err.message, startTime, endTime);
      }
    }
  })();
}

// Dispatches transcribed text and filters common silence hallucinations
function handleTranscribedText(rawText, startTime, endTime, providerUsed) {
  let text = (rawText || '').trim();

  // Filter out common Whisper/AI silence & noise hallucinations
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
    console.log(`Filtered out hallucination: "${text}"`);
    return;
  }

  if (text) {
    lastPromptContext = (lastPromptContext + ' ' + text).slice(-300);
    chrome.runtime.sendMessage({
      type: 'UPDATE_STATS',
      durationSec: (endTime - startTime),
      provider: providerUsed || apiProvider
    });
    tokenizeAndForward(text, startTime, endTime);
  }
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
