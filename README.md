# 💪 Rikimashou! (力ましょう！)
### Real-Time Japanese Video Immersion & Morphological Subtitles

**Rikimashou!** is a high-performance Chromium extension (Google Chrome & Microsoft Edge) designed to turn any Japanese video into an interactive language learning environment. It captures live tab audio, transcribes speech with sub-second latency using Groq Whisper Large V3, parses Japanese morphology locally via Kuromoji, and displays interactive, color-coded subtitles with stacked Furigana and Romaji.

---

## ✨ Features

- **⚡ Sub-Second Real-Time Transcription**: Ultra-fast audio chunking (650ms speech buffer, 220ms silence cutoff) and contextual prompt conditioning powered by Groq's `whisper-large-v3`.
- **🧩 Smart Morphological Compound Reconstruction**: Automatically recombines verb stems with auxiliary suffixes and conjunctive particles (e.g. `食べ` + `まし` + `た` → `食べました`, `し` + `て` → `して`) mapped to their dictionary base lemma.
- **🎯 Clean Particle Separation**: Grammatical particles and object markers (`を`, `は`, `が`, `に`, `で`, etc.) are styled as clean grammatical glue and excluded from vocabulary counts so they never pollute your word bank.
- **🏮 Stacked 3-Story Ruby Typography**: Kanji, Furigana (reading), and micro Romaji rendered in vertical alignment.
- **🎨 21st.dev Dark Glassmorphic Aesthetic**: Deep obsidian backdrop blur, refined micro-interactions with spring physics, and clean vector controls.
- **📚 Local JLPT Vocabulary Database**: Over 13,800 entries bundled locally for instant offline definitions and N5–N1 color coding.
- **🎴 AnkiConnect Integration**: One-click vocabulary mining that creates rich flashcards directly into your desktop Anki deck.
- **↺ Sentence Replay & History**: Replay previous sentences and inspect past dialogue lines at any time.
- **🔒 Zero-Exposure Security**: API keys are isolated in your local `.env` file and never hardcoded in source files.

---

## 📁 Project Architecture

```
osakekudasai/
├── .env                  # Local secret keys (ignored by git)
├── .env.example          # Environment variable template
├── .gitignore            # Git exclusion rules
├── manifest.json         # Chrome Extension Manifest V3 configuration
├── package.json          # Node dependencies and build scripts
│
├── background/           # Service worker & extension lifecycle
│   └── background.js     # Tab audio capture setup, .env sync, rate-limit supervisor
│
├── content/              # Webpage injected scripts & overlay UI
│   ├── content.js        # Subtitle DOM rendering, dictionary card, video controllers
│   └── content.css       # 21st.dev inspired glassmorphic overlay styling
│
├── offscreen/            # Web Audio & NLP isolated sandbox
│   ├── offscreen.html    # Offscreen execution context
│   └── offscreen.js      # MediaRecorder, Groq/OpenAI Whisper client, Kuromoji tokenization
│
├── popup/                # Toolbar popup interface
│   ├── popup.html        # Status indicator & quick capture toggle
│   ├── popup.js          # Popup controller
│   └── popup.css         # Dark minimal popup styling
│
├── options/              # Settings & Anki dashboard
│   ├── options.html      # Settings UI
│   ├── options.js        # Storage sync & AnkiConnect tests
│   └── options.css       # Obsidian settings styling
│
├── scripts/              # Developer build utilities
│   ├── compile_dict.js   # Compiles raw JLPT CSV into indexed JSON dictionary
│   └── generate_icons.js # Generates PNG extension icons
│
├── dict/                 # Bundled offline database
│   └── jlpt_dict.json    # Local JLPT N1-N5 dictionary
│
└── lib/                  # Bundled dependencies
    ├── kuromoji.js       # Japanese morphological analyzer engine
    └── dict/             # Kuromoji binary dictionary data
```

---

## 🚀 Getting Started

### 1. Configure Your API Key
1. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```
2. Open `.env` and add your Groq API key:
   ```env
   GROQ_API_KEY=gsk_your_groq_api_key_here
   ```
   *(Get a free, ultra-fast API key from [Groq Cloud Console](https://console.groq.com/keys)).*

### 2. Load into Chrome or Edge
1. Open your browser and navigate to:
   - Microsoft Edge: `edge://extensions/`
   - Google Chrome: `chrome://extensions/`
2. Enable **Developer mode** (toggle in the corner).
3. Click **Load unpacked** and select the `osakekudasai` folder.

### 3. Usage
1. Open any Japanese video on YouTube or streaming platforms.
2. Click the **Rikimashou!** icon in your browser toolbar and click **Start Capture**.
3. Enjoy real-time, color-coded interactive subtitles!

---

## 📄 License
MIT License. Created by [@mehakag1120-cmd](https://github.com/mehakag1120-cmd).
