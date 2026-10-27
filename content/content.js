(function() {
  // Prevent duplicate injections
  if (window.hasOwnProperty('__rikimashouInjected')) {
    console.log("Rikimashou! content script already active.");
    return;
  }
  window.__rikimashouInjected = true;

  // Global states
  let overlayContainer = null;
  let subtitleTextContainer = null;
  let historyDrawer = null;
  let statusBadge = null;
  let activeTooltip = null;

  // Precise Replay states
  let activeReplayToken = 0;

  // Config variables
  let subtitleMode = 'beginner'; // beginner, intermediate, advanced
  let readingStyle = 'hiragana'; // hiragana, katakana, romaji
  let autoPauseOnHover = false;
  let wasPausedByHover = false;

  // Anki settings
  let ankiEnabled = false;
  let ankiDeck = 'Rikimashou! Immersion';

  // Local storage caches for vocab & history
  let savedVocab = {};
  let knownWords = {};
  let subtitleHistory = []; // Tracks parsed subtitle segments: { tokens, text, startTime, endTime }

  // Load saved lists from storage
  function loadVocabLists() {
    chrome.storage.local.get(['savedVocab', 'knownWords', 'subtitleMode', 'readingStyle', 'autoPauseOnHover', 'ankiEnabled', 'ankiDeck'], (data) => {
      savedVocab = data.savedVocab || {};
      knownWords = data.knownWords || {};
      ankiEnabled = data.ankiEnabled || false;
      ankiDeck = data.ankiDeck || 'Rikimashou! Immersion';
      
      if (data.subtitleMode) subtitleMode = data.subtitleMode;
      if (data.readingStyle) readingStyle = data.readingStyle;
      if (data.autoPauseOnHover !== undefined) autoPauseOnHover = data.autoPauseOnHover;
      
      // Update UI if overlay exists
      if (overlayContainer) {
        document.querySelector('.osake-mode-select').value = subtitleMode;
        document.querySelector('.osake-reading-select').value = readingStyle;
        document.getElementById('osake-autopause-chk').checked = autoPauseOnHover;
        updateOverlayClass();
      }
    });
  }
  loadVocabLists();

  // Listeners for background communications
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
      case 'QUERY_VIDEO_TIME':
        const video = document.querySelector('video');
        sendResponse({ currentTime: video ? video.currentTime : Date.now() / 1000 });
        break;

      case 'SHOW_OVERLAY':
        createOverlay();
        sendResponse({ success: true });
        break;

      case 'HIDE_OVERLAY':
        removeOverlay();
        sendResponse({ success: true });
        break;

      case 'RENDER_SUBTITLE':
        renderSubtitle(message.tokens, message.text, message.startTime, message.endTime);
        sendResponse({ success: true });
        break;

      case 'UPDATE_STATUS_BADGE':
        if (statusBadge) {
          statusBadge.textContent = message.statusText;
          statusBadge.classList.toggle('osake-status-warning', message.statusText.includes('RATE LIMITED'));
        }
        sendResponse({ success: true });
        break;
    }
    return false;
  });

  // Create Overlay Panel
  function createOverlay() {
    if (overlayContainer) return;

    // Outer Container
    overlayContainer = document.createElement('div');
    overlayContainer.id = 'osake-subtitle-overlay';
    overlayContainer.className = 'osake-overlay-panel';
    updateOverlayClass();

    // Drag Handle
    const dragHandle = document.createElement('div');
    dragHandle.className = 'osake-drag-handle';
    
    // Status Badge & Title
    const headerInfo = document.createElement('div');
    headerInfo.className = 'osake-header-info';

    statusBadge = document.createElement('span');
    statusBadge.className = 'osake-status-badge';
    statusBadge.innerHTML = '<span class="osake-pulse-dot"></span><span class="osake-status-label">LIVE CAPTURE</span>';
    headerInfo.appendChild(statusBadge);

    // Control buttons inside header
    const headerBtns = document.createElement('div');
    headerBtns.className = 'osake-header-buttons';

    // Current sentence replay button
    const replayBtn = document.createElement('button');
    replayBtn.className = 'osake-header-btn';
    replayBtn.title = 'Replay current sentence';
    replayBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg><span>Replay</span>';
    replayBtn.addEventListener('click', () => {
      if (lastStart !== undefined && lastEnd !== undefined) {
        replaySentence(lastStart, lastEnd);
      }
    });
    headerBtns.appendChild(replayBtn);

    // Collapsible history drawer trigger
    const historyBtn = document.createElement('button');
    historyBtn.className = 'osake-header-btn';
    historyBtn.title = 'Toggle Subtitle History';
    historyBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8v4l3 3"/><circle cx="12" cy="12" r="9"/></svg><span>History</span>';
    historyBtn.addEventListener('click', () => {
      overlayContainer.classList.toggle('osake-drawer-open');
      historyBtn.classList.toggle('active');
      renderHistoryList();
    });
    headerBtns.appendChild(historyBtn);

    headerInfo.appendChild(headerBtns);
    dragHandle.appendChild(headerInfo);

    // Close Button
    const closeBtn = document.createElement('button');
    closeBtn.className = 'osake-close-btn';
    closeBtn.title = 'Close Immersion Overlay';
    closeBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    closeBtn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'STOP_CAPTURE' });
    });
    dragHandle.appendChild(closeBtn);

    overlayContainer.appendChild(dragHandle);

    // Subtitle Container
    subtitleTextContainer = document.createElement('div');
    subtitleTextContainer.className = 'osake-subtitle-text';
    subtitleTextContainer.textContent = 'Waiting for Japanese speech...';
    overlayContainer.appendChild(subtitleTextContainer);

    // Collapsible History Drawer container
    historyDrawer = document.createElement('div');
    historyDrawer.className = 'osake-history-drawer';
    overlayContainer.appendChild(historyDrawer);

    // Settings / Control Bar at the bottom
    const settingsBar = document.createElement('div');
    settingsBar.className = 'osake-settings-bar';

    // Subtitle Mode Select
    const modeSelect = document.createElement('select');
    modeSelect.className = 'osake-control-item osake-mode-select';
    modeSelect.innerHTML = `
      <option value="beginner">Beginner (Furigana + Tooltip)</option>
      <option value="intermediate">Intermediate (Furigana Only)</option>
      <option value="advanced">Advanced (Kanji Only)</option>
    `;
    modeSelect.value = subtitleMode;
    modeSelect.addEventListener('change', (e) => {
      subtitleMode = e.target.value;
      chrome.storage.local.set({ subtitleMode });
      updateOverlayClass();
    });
    settingsBar.appendChild(modeSelect);

    // Reading Style Select
    const readingSelect = document.createElement('select');
    readingSelect.className = 'osake-control-item osake-reading-select';
    readingSelect.innerHTML = `
      <option value="hiragana">Hiragana</option>
      <option value="katakana">Katakana</option>
      <option value="romaji">Romaji</option>
    `;
    readingSelect.value = readingStyle;
    readingSelect.addEventListener('change', (e) => {
      readingStyle = e.target.value;
      chrome.storage.local.set({ readingStyle });
      // Rerender active subtitles if any exist
      if (lastTokens) renderSubtitle(lastTokens, lastRawText, lastStart, lastEnd);
    });
    settingsBar.appendChild(readingSelect);

    // Auto-Pause checkbox
    const autoPauseLabel = document.createElement('label');
    autoPauseLabel.className = 'osake-checkbox-control';
    autoPauseLabel.innerHTML = `
      <input type="checkbox" id="osake-autopause-chk">
      <span>Auto-Pause on Hover</span>
    `;
    const apChk = autoPauseLabel.querySelector('input');
    apChk.checked = autoPauseOnHover;
    apChk.addEventListener('change', (e) => {
      autoPauseOnHover = e.target.checked;
      chrome.storage.local.set({ autoPauseOnHover });
    });
    settingsBar.appendChild(autoPauseLabel);

    overlayContainer.appendChild(settingsBar);

    document.body.appendChild(overlayContainer);

    // Make it draggable
    makeDraggable(overlayContainer, dragHandle);
  }

  function updateOverlayClass() {
    if (!overlayContainer) return;
    overlayContainer.classList.remove('osake-mode-beginner', 'osake-mode-intermediate', 'osake-mode-advanced');
    overlayContainer.classList.add(`osake-mode-${subtitleMode}`);
  }

  // Remove Overlay Panel
  function removeOverlay() {
    dismissTooltip();
    if (overlayContainer) {
      overlayContainer.remove();
      overlayContainer = null;
      subtitleTextContainer = null;
      historyDrawer = null;
    }
  }

  // Precise Sentence Replay controller
  function replaySentence(startTime, endTime) {
    const video = document.querySelector('video');
    if (!video) return;

    // Increment token to cancel out any stale playback checks
    const currentToken = ++activeReplayToken;

    video.currentTime = startTime;
    video.play().catch(() => {});

    // Listen to video progress to trigger auto-pause at endTime
    const checkEnd = () => {
      if (currentToken !== activeReplayToken) {
        video.removeEventListener('timeupdate', checkEnd);
        video.removeEventListener('seeking', checkSeek);
        return;
      }

      if (video.currentTime >= endTime) {
        video.pause();
        video.removeEventListener('timeupdate', checkEnd);
        video.removeEventListener('seeking', checkSeek);
      }
    };

    // If user manual seeks timeline, cancel active replay auto-pause
    const checkSeek = () => {
      activeReplayToken++; // Invalidates currentToken check
      video.removeEventListener('timeupdate', checkEnd);
      video.removeEventListener('seeking', checkSeek);
    };

    video.addEventListener('timeupdate', checkEnd);
    video.addEventListener('seeking', checkSeek);
  }

  // Cache last subtitle to support dynamic rerendering
  let lastTokens = null;
  let lastRawText = "";
  let lastStart = 0;
  let lastEnd = 0;

  // Render Tokenized Japanese Subtitles
  function renderSubtitle(tokens, rawText, startTime, endTime) {
    lastTokens = tokens;
    lastRawText = rawText;
    lastStart = startTime;
    lastEnd = endTime;

    if (!subtitleTextContainer) {
      createOverlay();
    }

    // Dismiss active popup when sentence changes
    dismissTooltip();

    // Push into history logs
    // Check if the duplicate entry is already at the end of history to prevent duplication on settings updates
    if (subtitleHistory.length === 0 || subtitleHistory[subtitleHistory.length - 1].startTime !== startTime) {
      subtitleHistory.push({ tokens, text: rawText, startTime, endTime });
      if (subtitleHistory.length > 200) {
        subtitleHistory.shift();
      }
      // If history drawer is open, refresh listing
      if (overlayContainer.classList.contains('osake-drawer-open')) {
        renderHistoryList();
      }
    }

    // Clear previous subtitles
    subtitleTextContainer.textContent = '';
    renderTokensToElement(tokens, subtitleTextContainer);
  }

  // Render tokens list to an HTML container
  function renderTokensToElement(tokens, element) {
    tokens.forEach(token => {
      const span = document.createElement('span');
      
      // 1. Grammatical particles & object markers (助詞) - styled as subtle grammar glue, never treated as vocabulary words
      if (token.isParticle || token.pos === '助詞') {
        span.className = 'osake-particle-token';
        
        if (token.reading && subtitleMode !== 'advanced') {
          const ruby = document.createElement('ruby');
          ruby.textContent = token.surface;
          const rt = document.createElement('rt');
          const romajiSpan = document.createElement('span');
          romajiSpan.className = 'osake-ruby-romaji';
          romajiSpan.textContent = hiraganaToRomaji(katakanaToHiragana(token.reading));
          rt.appendChild(romajiSpan);
          ruby.appendChild(rt);
          span.appendChild(ruby);
        } else {
          span.textContent = token.surface;
        }
      }
      // 2. Real Content Words (Nouns, Verbs, Adjectives, Adverbs) - Interactive with JLPT, Hover & Dictionary
      else if (token.isContentWord || (token.pos !== '記号' && token.pos !== 'Unknown')) {
        span.className = 'osake-word-token';
        
        if (token.jlpt) {
          span.classList.add(`osake-jlpt-${token.jlpt}`);
        }

        if (knownWords[token.baseForm]) {
          span.classList.add('osake-word-known');
        }

        const furigana = getFuriganaParts(token.surface, token.reading);
        const hasReading = !!token.reading;
        
        if (hasReading && subtitleMode !== 'advanced') {
          const ruby = document.createElement('ruby');
          const rt = document.createElement('rt');
          
          if (furigana && furigana.kanjiPart !== furigana.readingPart) {
            // Kanji word: render Kanji at bottom, Furigana + Romaji in <rt>
            ruby.textContent = furigana.kanjiPart;
            
            const fText = formatReading(furigana.readingPart, token.reading);
            rt.textContent = fText;
            
            const romajiSpan = document.createElement('span');
            romajiSpan.className = 'osake-ruby-romaji';
            romajiSpan.textContent = hiraganaToRomaji(katakanaToHiragana(furigana.readingPart));
            rt.appendChild(romajiSpan);
            
            ruby.appendChild(rt);
            span.appendChild(ruby);
            
            if (furigana.okuriganaPart) {
              const okuriRuby = document.createElement('ruby');
              okuriRuby.textContent = furigana.okuriganaPart;
              const okuriRt = document.createElement('rt');
              const okuriRomaji = document.createElement('span');
              okuriRomaji.className = 'osake-ruby-romaji';
              okuriRomaji.textContent = hiraganaToRomaji(katakanaToHiragana(furigana.okuriganaPart));
              okuriRt.appendChild(okuriRomaji);
              okuriRuby.appendChild(okuriRt);
              span.appendChild(okuriRuby);
            }
          } else {
            // Kana-only word: render word at bottom, Romaji in <rt> (no duplicate furigana)
            ruby.textContent = token.surface;
            
            const romajiSpan = document.createElement('span');
            romajiSpan.className = 'osake-ruby-romaji';
            romajiSpan.textContent = hiraganaToRomaji(katakanaToHiragana(token.reading));
            rt.appendChild(romajiSpan);
            
            ruby.appendChild(rt);
            span.appendChild(ruby);
          }
        } else {
          span.textContent = token.surface;
        }

        span.addEventListener('mouseenter', () => {
          if (autoPauseOnHover) {
            const video = document.querySelector('video');
            if (video && !video.paused) {
              video.pause();
              wasPausedByHover = true;
            }
          }
        });

        span.addEventListener('mouseleave', (e) => {
          if (wasPausedByHover && (!activeTooltip || !activeTooltip.contains(e.relatedTarget))) {
            resumeVideoPlayback();
          }
        });

        span.addEventListener('click', (e) => {
          e.stopPropagation();
          showDictionaryPopup(token, span);
        });

      } else {
        span.className = 'osake-symbol-token';
        span.textContent = token.surface;
      }
      
      element.appendChild(span);
    });
  }

  // Render history drawer content
  function renderHistoryList() {
    if (!historyDrawer) return;
    historyDrawer.textContent = '';

    // Loop backwards so newest records are at the top
    for (let i = subtitleHistory.length - 1; i >= 0; i--) {
      const item = subtitleHistory[i];
      const row = document.createElement('div');
      row.className = 'osake-history-item';

      // 1. Time Label
      const timeSpan = document.createElement('span');
      timeSpan.className = 'osake-history-time';
      const m = Math.floor(item.startTime / 60);
      const s = Math.floor(item.startTime % 60);
      timeSpan.textContent = `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
      row.appendChild(timeSpan);

      // 2. Tokenized subtitles text
      const tokensContainer = document.createElement('div');
      tokensContainer.className = 'osake-history-tokens';
      renderTokensToElement(item.tokens, tokensContainer);
      row.appendChild(tokensContainer);

      // 3. Actions Row (Replay)
      const actions = document.createElement('div');
      actions.className = 'osake-history-actions';

      const replayItemBtn = document.createElement('button');
      replayItemBtn.className = 'osake-history-replay-btn';
      replayItemBtn.innerHTML = '↺';
      replayItemBtn.title = 'Replay sentence segment';
      replayItemBtn.addEventListener('click', () => {
        replaySentence(item.startTime, item.endTime);
      });
      actions.appendChild(replayItemBtn);

      row.appendChild(actions);
      historyDrawer.appendChild(row);
    }

    if (subtitleHistory.length === 0) {
      const emptyMsg = document.createElement('div');
      emptyMsg.style.padding = '12px';
      emptyMsg.style.textAlign = 'center';
      emptyMsg.style.color = '#9ea0b0';
      emptyMsg.style.fontSize = '12px';
      emptyMsg.textContent = 'History drawer is empty.';
      historyDrawer.appendChild(emptyMsg);
    }
  }

  function resumeVideoPlayback() {
    if (wasPausedByHover) {
      const video = document.querySelector('video');
      if (video && video.paused) {
        video.play().catch(() => {});
      }
      wasPausedByHover = false;
    }
  }

  // DICTIONARY POPUP CARD RENDERER
  function showDictionaryPopup(token, anchorSpan) {
    dismissTooltip();

    const tooltip = document.createElement('div');
    tooltip.className = 'osake-dict-tooltip';
    
    // Header Row
    const header = document.createElement('div');
    header.className = 'osake-dict-header';

    const wordInfo = document.createElement('div');
    wordInfo.className = 'osake-dict-word-info';

    const kanjiSpan = document.createElement('span');
    kanjiSpan.className = 'osake-dict-kanji';
    kanjiSpan.textContent = token.surface;
    wordInfo.appendChild(kanjiSpan);

    const readingSpan = document.createElement('span');
    readingSpan.className = 'osake-dict-reading';
    readingSpan.textContent = formatReading(katakanaToHiragana(token.reading), token.reading);
    wordInfo.appendChild(readingSpan);

    header.appendChild(wordInfo);

    // JLPT Badge
    if (token.jlpt) {
      const badge = document.createElement('span');
      badge.className = `osake-jlpt-badge jlpt-${token.jlpt}`;
      badge.textContent = `N${token.jlpt}`;
      header.appendChild(badge);
    }
    tooltip.appendChild(header);

    // Definitions Box
    const meaningSection = document.createElement('div');
    meaningSection.className = 'osake-dict-meaning-section';

    if (token.meaning) {
      renderLocalDefinitions(token.meaning, meaningSection);
    } else {
      meaningSection.textContent = 'Searching online Jotoba dictionary...';
      chrome.runtime.sendMessage({ type: 'LOOKUP_WORD', word: token.baseForm }, (response) => {
        if (!activeTooltip || activeTooltip !== tooltip) return;

        meaningSection.textContent = '';
        if (response && response.result && response.result.words && response.result.words.length > 0) {
          const senses = response.result.words[0].senses;
          if (senses && senses.length > 0) {
            senses.forEach(sense => {
              const engDef = sense.glosses || sense.english_definitions || [];
              if (engDef.length > 0) {
                const item = document.createElement('div');
                item.className = 'osake-dict-meaning-item';
                item.textContent = engDef.join(', ');
                meaningSection.appendChild(item);
              }
            });
          } else {
            meaningSection.textContent = 'Definition not found.';
          }
        } else {
          meaningSection.textContent = 'No online definition resolved.';
        }
      });
    }
    tooltip.appendChild(meaningSection);

    // Mined Vocab Stars & Known Words toggles
    const actions = document.createElement('div');
    actions.className = 'osake-dict-actions';

    // 1. Mine/Save Word Button (with AnkiConnect Sync check)
    const saveBtn = document.createElement('button');
    saveBtn.className = 'osake-action-btn';
    const isSaved = !!savedVocab[token.baseForm];
    saveBtn.className = isSaved ? 'osake-action-btn active' : 'osake-action-btn';
    saveBtn.textContent = isSaved ? '★ Saved' : '☆ Mine Word';
    saveBtn.addEventListener('click', () => {
      toggleSaveWord(token, saveBtn);
    });
    actions.appendChild(saveBtn);

    // 2. Mark Known button
    const knownBtn = document.createElement('button');
    const isKnown = !!knownWords[token.baseForm];
    knownBtn.className = isKnown ? 'osake-action-btn active' : 'osake-action-btn';
    knownBtn.textContent = isKnown ? '👁️ Known' : '👁️ Mark Known';
    knownBtn.addEventListener('click', () => {
      toggleKnownWord(token, knownBtn, anchorSpan);
    });
    actions.appendChild(knownBtn);

    tooltip.appendChild(actions);

    // Footer Links
    const linksRow = document.createElement('div');
    linksRow.className = 'osake-dict-links';

    const jishoLink = document.createElement('a');
    jishoLink.href = `https://jisho.org/search/${encodeURIComponent(token.baseForm)}`;
    jishoLink.target = '_blank';
    jishoLink.textContent = 'View on Jisho ↗';
    linksRow.appendChild(jishoLink);

    const translateLink = document.createElement('a');
    translateLink.href = `https://translate.google.com/?sl=ja&tl=en&text=${encodeURIComponent(token.baseForm)}`;
    translateLink.target = '_blank';
    translateLink.textContent = 'Translate ↗';
    linksRow.appendChild(translateLink);

    tooltip.appendChild(linksRow);

    document.body.appendChild(tooltip);
    activeTooltip = tooltip;

    // Position tooltip
    const rect = anchorSpan.getBoundingClientRect();
    let leftPos = rect.left + (rect.width - tooltip.offsetWidth) / 2;
    let topPos = rect.top - tooltip.offsetHeight - 8;

    if (leftPos < 10) leftPos = 10;
    if (leftPos + tooltip.offsetWidth > window.innerWidth - 10) {
      leftPos = window.innerWidth - tooltip.offsetWidth - 10;
    }
    if (topPos < 10) {
      topPos = rect.bottom + 8;
    }

    tooltip.style.left = leftPos + 'px';
    tooltip.style.top = topPos + 'px';

    tooltip.addEventListener('click', (e) => {
      e.stopPropagation();
    });

    tooltip.addEventListener('mouseleave', (e) => {
      if (wasPausedByHover && !anchorSpan.contains(e.relatedTarget)) {
        resumeVideoPlayback();
      }
    });
  }

  function renderLocalDefinitions(meaningsText, container) {
    const list = meaningsText.split(/[,;]/);
    list.slice(0, 3).forEach(m => {
      const item = document.createElement('div');
      item.className = 'osake-dict-meaning-item';
      item.textContent = m.trim();
      container.appendChild(item);
    });
  }

  function dismissTooltip() {
    if (activeTooltip) {
      activeTooltip.remove();
      activeTooltip = null;
    }
  }

  // Toggles mined words (savedVocab) and synchronizes to Anki if integration is active
  function toggleSaveWord(token, btn) {
    if (token.isParticle || token.pos === '助詞') return;
    const word = token.baseForm;
    if (savedVocab[word]) {
      delete savedVocab[word];
      btn.textContent = '☆ Mine Word';
      btn.className = 'osake-action-btn';
      chrome.storage.local.set({ savedVocab });
    } else {
      const entry = {
        word: word,
        reading: formatReading(katakanaToHiragana(token.reading), token.reading),
        meaning: token.meaning || 'Lookup pending',
        sentence: lastRawText || '',
        level: token.jlpt || null,
        url: window.location.href,
        timestamp: Date.now()
      };
      
      savedVocab[word] = entry;
      btn.textContent = '★ Saved';
      btn.className = 'osake-action-btn active';
      chrome.storage.local.set({ savedVocab });

      // Trigger AnkiConnect Sync
      if (ankiEnabled) {
        syncToAnki(entry, btn);
      }
    }
  }

  // AnkiConnect sync query
  function syncToAnki(entry, btn) {
    console.log("Synchronizing mined word to Anki deck:", ankiDeck);
    
    const note = {
      deckName: ankiDeck,
      modelName: "Basic",
      fields: {
        Front: entry.word,
        Back: `${entry.reading}<br><br><b>Definition:</b> ${entry.meaning}<br><br><b>Sentence Context:</b><br><i>${entry.sentence}</i><br><br><a href="${entry.url}">Video Source</a>`
      },
      tags: ["Rikimashou", "VocabularyMining"]
    };

    fetch('http://localhost:8765', {
      method: 'POST',
      body: JSON.stringify({
        action: 'addNote',
        version: 6,
        params: { note }
      })
    })
    .then(res => res.json())
    .then(res => {
      if (res.error) {
        console.error("AnkiConnect rejected the card:", res.error);
        btn.textContent = '★ Save Error';
        btn.style.color = '#ff1744';
      } else {
        console.log("Card added successfully. Note ID:", res.result);
        btn.textContent = '★ Synced';
        btn.style.color = '#00e676';
        setTimeout(() => { btn.style.color = ''; }, 2000);
      }
    })
    .catch(err => {
      console.warn("AnkiConnect server unreachable. Saved locally only.", err.message);
      btn.textContent = '★ Local Only';
      btn.style.color = '#ffd600';
      setTimeout(() => { btn.style.color = ''; }, 2000);
    });
  }

  // Toggles known words (knownWords)
  function toggleKnownWord(token, btn, span) {
    const word = token.baseForm;
    if (knownWords[word]) {
      delete knownWords[word];
      btn.textContent = '👁️ Mark Known';
      btn.className = 'osake-action-btn';
      span.classList.remove('osake-word-known');
    } else {
      knownWords[word] = true;
      btn.textContent = '👁️ Known';
      btn.className = 'osake-action-btn active';
      span.classList.add('osake-word-known');
    }
    chrome.storage.local.set({ knownWords });
  }

  // Close dictionary popups on body click
  document.addEventListener('click', () => {
    dismissTooltip();
    resumeVideoPlayback();
  });

  // CONVERTER HELPERS
  function katakanaToHiragana(katakana) {
    if (!katakana) return '';
    return katakana.replace(/[\u30a1-\u30f6]/g, function(match) {
      return String.fromCharCode(match.charCodeAt(0) - 0x60);
    });
  }

  function formatReading(hiragana, originalKatakana) {
    if (readingStyle === 'katakana') {
      return originalKatakana || '';
    } else if (readingStyle === 'romaji') {
      return hiraganaToRomaji(hiragana);
    }
    return hiragana;
  }

  function getFuriganaParts(surface, readingKatakana) {
    if (!readingKatakana) return null;
    const readingHiragana = katakanaToHiragana(readingKatakana);
    
    // Check if word contains Kanji
    if (!/[\u4e00-\u9faf]/.test(surface)) return null;

    let sIdx = surface.length - 1;
    let rIdx = readingHiragana.length - 1;

    while (sIdx >= 0 && rIdx >= 0) {
      if (surface[sIdx] === readingHiragana[rIdx]) {
        sIdx--;
        rIdx--;
      } else {
        break;
      }
    }

    const kanjiPart = surface.substring(0, sIdx + 1);
    const readingPart = readingHiragana.substring(0, rIdx + 1);
    const okuriganaPart = surface.substring(sIdx + 1);

    if (!kanjiPart || !readingPart) {
      return {
        kanjiPart: surface,
        readingPart: readingHiragana,
        okuriganaPart: ''
      };
    }

    return {
      kanjiPart,
      readingPart,
      okuriganaPart
    };
  }

  function katakanaToHiragana(str) {
    if (!str) return '';
    return str.replace(/[\u30a1-\u30f6]/g, (match) => {
      return String.fromCharCode(match.charCodeAt(0) - 0x60);
    });
  }

  function hiraganaToRomaji(hiragana) {
    const map = {
      'あ': 'a', 'い': 'i', 'う': 'u', 'え': 'e', 'お': 'o',
      'か': 'ka', 'き': 'ki', 'く': 'ku', 'け': 'ke', 'こ': 'ko',
      'さ': 'sa', 'し': 'shi', 'す': 'su', 'せ': 'se', 'そ': 'so',
      'た': 'ta', 'ち': 'chi', 'つ': 'tsu', 'て': 'te', 'と': 'to',
      'な': 'na', 'に': 'ni', 'ぬ': 'nu', 'ね': 'ne', 'の': 'no',
      'は': 'ha', 'ひ': 'hi', 'ふ': 'fu', 'へ': 'he', 'ほ': 'ho',
      'ま': 'ma', 'み': 'mi', 'む': 'mu', 'め': 'me', 'も': 'mo',
      'や': 'ya', 'ゆ': 'yu', 'よ': 'yo',
      'ら': 'ra', 'り': 'ri', 'る': 'ru', 'れ': 're', 'ろ': 'ro',
      'わ': 'wa', 'を': 'o', 'ん': 'n',
      'が': 'ga', 'ぎ': 'gi', 'ぐ': 'gu', 'げ': 'ge', 'ご': 'go',
      'ざ': 'za', 'じ': 'ji', 'ず': 'zu', 'ぜ': 'ze', 'ぞ': 'zo',
      'だ': 'da', 'ぢ': 'ji', 'づ': 'zu', 'で': 'de', 'ど': 'do',
      'ば': 'ba', 'び': 'bi', 'ぶ': 'bu', 'べ': 'be', 'ぼ': 'bo',
      'ぱ': 'pa', 'ぴ': 'pi', 'ぷ': 'pu', 'ぺ': 'pe', 'ぽ': 'po',
      'きゃ': 'kya', 'きゅ': 'kyu', 'きょ': 'kyo',
      'しゃ': 'sha', 'しゅ': 'shu', 'しょ': 'sho',
      'ちゃ': 'cha', 'ちゅ': 'chu', 'ちょ': 'cho',
      'にゃ': 'nya', 'にゅ': 'nyu', 'にょ': 'nyo',
      'ひゃ': 'hya', 'ひゅ': 'hyu', 'ひょ': 'hyo',
      'みゃ': 'mya', 'みゅ': 'myu', 'みょ': 'myo',
      'りゃ': 'rya', 'りゅ': 'ryu', 'りょ': 'ryo',
      'ぎゃ': 'gya', 'ぎゅ': 'gyu', 'ぎょ': 'gyo',
      'じゃ': 'ja', 'じゅ': 'ju', 'じょ': 'jo',
      'びゃ': 'bya', 'びゅ': 'byu', 'びょ': 'byo',
      'ぴゃ': 'pya', 'ぴゅ': 'pyu', 'ぴょ': 'pyo'
    };

    let romaji = '';
    let i = 0;
    while (i < hiragana.length) {
      if (i + 1 < hiragana.length) {
        const combo = hiragana.substring(i, i + 2);
        if (map[combo]) {
          romaji += map[combo];
          i += 2;
          continue;
        }
      }
      const char = hiragana[i];
      if (char === 'っ' && i + 1 < hiragana.length) {
        const nextChar = hiragana[i + 1];
        const nextRomaji = map[nextChar] || '';
        if (nextRomaji) {
          romaji += nextRomaji[0];
        }
        i++;
      } else {
        romaji += map[char] || char;
        i++;
      }
    }
    return romaji;
  }

  // Draggable helper (same as Phase 1)
  function makeDraggable(elm, handle) {
    let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
    handle.onmousedown = dragMouseDown;

    function dragMouseDown(e) {
      e = e || window.event;
      if (e.button !== 0) return;
      e.preventDefault();
      pos3 = e.clientX;
      pos4 = e.clientY;
      document.onmouseup = closeDragElement;
      document.onmousemove = elementDrag;
    }

    function elementDrag(e) {
      e = e || window.event;
      e.preventDefault();
      pos1 = pos3 - e.clientX;
      pos2 = pos4 - e.clientY;
      pos3 = e.clientX;
      pos4 = e.clientY;

      let newTop = elm.offsetTop - pos2;
      let newLeft = elm.offsetLeft - pos1;

      const screenWidth = window.innerWidth;
      const screenHeight = window.innerHeight;

      if (newTop < 10) newTop = 10;
      if (newTop > screenHeight - 120) newTop = screenHeight - 120;
      if (newLeft < 10) newLeft = 10;
      if (newLeft > screenWidth - 300) newLeft = screenWidth - 300;

      elm.style.top = newTop + "px";
      elm.style.left = newLeft + "px";
      elm.style.bottom = 'auto';
    }

    function closeDragElement() {
      document.onmouseup = null;
      document.onmousemove = null;
    }
  }
})();
