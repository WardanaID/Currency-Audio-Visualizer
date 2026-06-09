/* ============================================================
   Content Script - Chart Detection & Orchestration
   Detects Google currency charts and injects the visualizer
   ============================================================ */

(function () {
  'use strict';

  // --- Configuration ---
  const SELECTORS = [
    '[data-attrid*="CurrencyConverter"]',
    '[data-attrid*="currency"]',
    '[data-attrid^="kc:/finance"]',
    '[data-attrid="kc:/gwp/key_stats:currency"]',
  ];

  // Text markers found in Google's chart time-range buttons (multi-language)
  const CHART_TEXT_MARKERS = [
    '1HR', '5HR', '1BLN', '1TH', '5TH', 'Maks',  // Indonesian
    '1D', '5D', '1M', '1Y', '5Y', 'Max',          // English
    '1H', '6H', '1W',                               // Alt English
  ];

  let injected = false;
  let currentVisualizer = null;
  let chartContainer = null;
  let currentSensitivity = 2.0;
  let currentBaseline = 1.0;
  let currentSmoothFactor = 0.10;
  let currentNumberSpeed = 0.2;
  let currentAnimateNumber = true;

  let currencyAnimationId = null;
  let currencyElements = [];
  let currencyStartTime = null;

  // Read saved settings from storage
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get({
      sensitivity: 2.0,
      waveBaseline: 1.0,
      waveSmoothFactor: 0.10,
      animateNumber: true,
      numberSpeed: 0.2
    }, (result) => {
      currentSensitivity = result.sensitivity;
      currentBaseline = result.waveBaseline;
      currentSmoothFactor = result.waveSmoothFactor;
      currentAnimateNumber = result.animateNumber;
      currentNumberSpeed = result.numberSpeed;
      if (currentVisualizer) {
        currentVisualizer.sensitivity = currentSensitivity;
        currentVisualizer.waveBaseline = currentBaseline;
        currentVisualizer.waveSmoothFactor = currentSmoothFactor;
      }
    });

    // Listen for real-time changes from popup sliders
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.sensitivity) {
        currentSensitivity = changes.sensitivity.newValue;
        if (currentVisualizer) currentVisualizer.sensitivity = currentSensitivity;
      }
      if (changes.waveBaseline) {
        currentBaseline = changes.waveBaseline.newValue;
        if (currentVisualizer) currentVisualizer.waveBaseline = currentBaseline;
      }
      if (changes.waveSmoothFactor) {
        currentSmoothFactor = changes.waveSmoothFactor.newValue;
        if (currentVisualizer) currentVisualizer.waveSmoothFactor = currentSmoothFactor;
      }
      if (changes.animateNumber) {
        currentAnimateNumber = changes.animateNumber.newValue;
        if (!currentAnimateNumber) {
          stopCurrencyAnimation();
        } else if (currentVisualizer && currentVisualizer.isPlaying && chartContainer) {
          startCurrencyAnimation(chartContainer);
        }
      }
      if (changes.numberSpeed) {
        currentNumberSpeed = changes.numberSpeed.newValue;
      }
    });
  }

  // ========================================================
  // CURRENCY VALUE RISE ANIMATION HELPERS
  // ========================================================

  /**
   * Detect precision, thousand separator, and decimal separator of a formatted string number
   */
  function detectFormat(str) {
    const clean = str.trim();
    let thousandSeparator = '';
    let decimalSeparator = '.';
    let precision = 2;

    const lastDot = clean.lastIndexOf('.');
    const lastComma = clean.lastIndexOf(',');

    if (lastDot > lastComma) {
      decimalSeparator = '.';
      if (lastComma !== -1) {
        thousandSeparator = ',';
      }
      precision = clean.length - lastDot - 1;
    } else if (lastComma > lastDot) {
      decimalSeparator = ',';
      if (lastDot !== -1) {
        thousandSeparator = '.';
      }
      precision = clean.length - lastComma - 1;
    } else {
      decimalSeparator = '';
    }

    if (isNaN(precision) || precision < 0 || precision > 10) {
      precision = 2;
    }

    return { thousandSeparator, decimalSeparator, precision };
  }

  /**
   * Parse a formatted string number to a float
   */
  function parseNumber(str, format) {
    let clean = str;
    if (format.thousandSeparator) {
      clean = clean.split(format.thousandSeparator).join('');
    }
    if (format.decimalSeparator && format.decimalSeparator !== '.') {
      clean = clean.replace(format.decimalSeparator, '.');
    }
    clean = clean.replace(/[^0-9.-]/g, '');
    return parseFloat(clean);
  }

  /**
   * Format a float number into a localized string format
   */
  function formatNumber(val, format) {
    const parts = val.toFixed(format.precision).split('.');
    let integerPart = parts[0];
    const decimalPart = parts[1];

    if (format.thousandSeparator) {
      integerPart = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, format.thousandSeparator);
    }

    if (format.decimalSeparator && decimalPart !== undefined) {
      return integerPart + format.decimalSeparator + decimalPart;
    }
    return integerPart;
  }

  /**
   * Traverse the DOM to find elements that display the currency conversion result
   */
  function findCurrencyValueElements(container) {
    const elements = [];
    // We walk up to the grandparent container of the chart to search for currency details
    // since the conversion numbers are outside the chart wrapper itself but inside the main converter card
    let mainCard = container;
    for (let i = 0; i < 4; i++) {
      if (mainCard.parentElement && 
          (mainCard.parentElement.getAttribute('data-attrid') || 
           mainCard.parentElement.id === 'rso' || 
           mainCard.parentElement.classList.contains('c2xzbc') || // common google result columns
           mainCard.parentElement.tagName.toLowerCase() === 'g-card')) {
        mainCard = mainCard.parentElement;
        break;
      }
      if (mainCard.parentElement) {
        mainCard = mainCard.parentElement;
      }
    }

    const inputs = mainCard.querySelectorAll('input');
    let targetVal = null;
    let targetInput = null;

    if (inputs.length >= 2) {
      targetInput = inputs[1];
      const fmt = detectFormat(targetInput.value);
      const val = parseNumber(targetInput.value, fmt);
      if (!isNaN(val)) {
        targetVal = val;
      }
    }

    if (targetInput && targetVal !== null) {
      const format = detectFormat(targetInput.value);
      elements.push({
        element: targetInput,
        isInput: true,
        originalText: targetInput.value,
        originalValue: targetVal,
        format: format
      });
    }

    function walk(node) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = node.tagName.toLowerCase();
        if (tag === 'script' || tag === 'style' || tag === 'select' || tag === 'input') {
          return;
        }

        let hasTextChild = false;
        for (const child of node.childNodes) {
          if (child.nodeType === Node.TEXT_NODE && child.textContent.trim().length > 0) {
            hasTextChild = true;
            break;
          }
        }

        if (hasTextChild) {
          const text = node.textContent.trim();
          const numRegex = /(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?)/g;
          let match;
          while ((match = numRegex.exec(text)) !== null) {
            const matchedStr = match[1];
            const fmt = detectFormat(matchedStr);
            const parsed = parseNumber(matchedStr, fmt);

            if (!isNaN(parsed)) {
              let isTarget = false;
              if (targetVal !== null) {
                if (Math.abs(parsed - targetVal) < 2.0) {
                  isTarget = true;
                }
              } else {
                if (parsed > 1.0) {
                  isTarget = true;
                }
              }

              if (isTarget) {
                if (!elements.some(e => e.element === node)) {
                  elements.push({
                    element: node,
                    isInput: false,
                    originalText: node.textContent,
                    matchedString: matchedStr,
                    originalValue: parsed,
                    format: fmt
                  });
                }
              }
            }
          }
        }

        for (const child of node.childNodes) {
          walk(child);
        }
      }
    }

    walk(mainCard);
    return elements;
  }

  /**
   * Starts animating the currency conversion numbers upwards
   */
  function startCurrencyAnimation(container) {
    stopCurrencyAnimation();
    if (!currentAnimateNumber) return;

    currencyElements = findCurrencyValueElements(container);
    if (currencyElements.length === 0) return;

    currencyStartTime = performance.now();

    function update() {
      if (!currentVisualizer || !currentVisualizer.isPlaying || !currentAnimateNumber) {
        stopCurrencyAnimation();
        return;
      }

      const elapsedSeconds = (performance.now() - currencyStartTime) / 1000;
      const factor = 1 + (currentNumberSpeed / 100) * elapsedSeconds;

      currencyElements.forEach(item => {
        const newValue = item.originalValue * factor;
        const formattedNewValue = formatNumber(newValue, item.format);

        if (item.isInput) {
          if (item.element.value !== formattedNewValue) {
            item.element.value = formattedNewValue;
            item.element.dispatchEvent(new Event('input', { bubbles: true }));
            item.element.dispatchEvent(new Event('change', { bubbles: true }));
          }
        } else {
          const updatedText = item.originalText.replace(item.matchedString, formattedNewValue);
          if (item.element.textContent !== updatedText) {
            item.element.textContent = updatedText;
          }
        }
      });

      currencyAnimationId = requestAnimationFrame(update);
    }

    currencyAnimationId = requestAnimationFrame(update);
  }

  /**
   * Stops the animation and restores currency numbers to their original values
   */
  function stopCurrencyAnimation() {
    if (currencyAnimationId) {
      cancelAnimationFrame(currencyAnimationId);
      currencyAnimationId = null;
    }

    currencyElements.forEach(item => {
      try {
        if (item.isInput) {
          if (item.element.value !== item.originalText) {
            item.element.value = item.originalText;
            item.element.dispatchEvent(new Event('input', { bubbles: true }));
            item.element.dispatchEvent(new Event('change', { bubbles: true }));
          }
        } else {
          if (item.element.textContent !== item.originalText) {
            item.element.textContent = item.originalText;
          }
        }
      } catch (err) {
        console.error('[ChartVisualizer] Restore error:', err);
      }
    });

    currencyElements = [];
    currencyStartTime = null;
  }

  // ========================================================
  // PRELOADED AUDIO
  // ========================================================

  /**
   * Retrieve preloaded audio from chrome.storage.local
   * Returns a File object or null
   */
  async function getPreloadedAudio() {
    return new Promise((resolve) => {
      if (typeof chrome === 'undefined' || !chrome.storage) {
        resolve(null);
        return;
      }
      chrome.storage.local.get(
        ['preloadedAudio', 'preloadedAudioName', 'preloadedAudioType'],
        (result) => {
          if (!result.preloadedAudio) {
            resolve(null);
            return;
          }
          try {
            const dataUrl = result.preloadedAudio;
            const parts = dataUrl.split(',');
            const mime = parts[0].match(/:(.*?);/)[1];
            const bstr = atob(parts[1]);
            const n = bstr.length;
            const u8 = new Uint8Array(n);
            for (let i = 0; i < n; i++) u8[i] = bstr.charCodeAt(i);
            const blob = new Blob([u8], { type: mime });
            const file = new File(
              [blob],
              result.preloadedAudioName || 'music.mp3',
              { type: mime }
            );
            resolve(file);
          } catch (err) {
            console.error('[ChartVisualizer] Failed to decode preloaded audio:', err);
            resolve(null);
          }
        }
      );
    });
  }

  // ========================================================
  // CHART DETECTION
  // ========================================================

  /**
   * Find the currency converter container using multiple strategies
   */
  function findCurrencyContainer() {
    // Strategy 1: data-attrid selectors (most reliable)
    for (const sel of SELECTORS) {
      const el = document.querySelector(sel);
      if (el) return el;
    }

    // Strategy 2: aria-label
    const ariaEl = document.querySelector('[aria-label*="currency" i], [aria-label*="mata uang" i]');
    if (ariaEl) return ariaEl;

    // Strategy 3: Search by chart text markers in #rso
    const rso = document.querySelector('#rso');
    if (!rso) return null;

    const candidates = rso.querySelectorAll('div');
    for (const div of candidates) {
      const text = div.textContent || '';
      const hasMarker = CHART_TEXT_MARKERS.some(m => {
        // Check for exact button-like text (short segments)
        return text.includes(m);
      });

      if (hasMarker) {
        // Verify it also contains SVG (the chart) or canvas
        if (div.querySelector('svg') || div.querySelector('canvas')) {
          return div;
        }
      }
    }

    return null;
  }

  /**
   * Find the chart/graph area within the container (the SVG area)
   */
  function findChartArea(container) {
    // Find the largest SVG element (that's the chart)
    const svgs = container.querySelectorAll('svg');
    let chartSvg = null;
    let maxArea = 0;

    svgs.forEach(svg => {
      const rect = svg.getBoundingClientRect();
      const area = rect.width * rect.height;
      // Must be a reasonably sized chart (not an icon)
      if (area > maxArea && rect.width > 100 && rect.height > 50) {
        maxArea = area;
        chartSvg = svg;
      }
    });

    if (chartSvg) {
      // Return the immediate parent div that wraps the SVG chart
      // Walk up to find a good container that's not too large
      let target = chartSvg.parentElement;
      while (target && target !== container) {
        const parentRect = target.parentElement?.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        // Stop if parent is significantly larger (we found the chart wrapper)
        if (parentRect && (parentRect.height > targetRect.height * 1.5)) {
          break;
        }
        target = target.parentElement;
      }
      return target || chartSvg.parentElement;
    }

    return null;
  }

  // ========================================================
  // TRIGGER INJECTION
  // ========================================================

  /**
   * Inject the hidden trigger button onto the chart area
   */
  function injectTrigger(chartArea) {
    if (injected || !chartArea) return;
    injected = true;
    chartContainer = chartArea;

    // Ensure relative positioning for absolute children
    const computedPos = window.getComputedStyle(chartArea).position;
    if (computedPos === 'static') {
      chartArea.style.position = 'relative';
    }

    // Add hover detection class
    chartArea.classList.add('cv-chart-container');

    // --- Create trigger button ---
    const trigger = document.createElement('div');
    trigger.className = 'cv-trigger';
    trigger.innerHTML = `
      <svg viewBox="0 0 24 24" width="14" height="14">
        <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
      </svg>
      <div class="cv-tooltip">Music Visualizer</div>
    `;

    // --- Hidden file input ---
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'audio/*,.mp3,.wav,.ogg,.flac,.m4a,.aac,.wma';
    fileInput.className = 'cv-file-input';

    // --- Event Handlers ---
    trigger.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();

      if (currentVisualizer && currentVisualizer.isPlaying) {
        // Stop and restore
        stopCurrencyAnimation();
        currentVisualizer.destroy();
        currentVisualizer = null;
        trigger.classList.remove('cv-active');
        return;
      }

      // Destroy stale visualizer
      if (currentVisualizer) {
        stopCurrencyAnimation();
        currentVisualizer.destroy();
        currentVisualizer = null;
      }

      // Try preloaded audio first
      const preloaded = await getPreloadedAudio();
      if (preloaded) {
        activateVisualizer(chartArea, preloaded, trigger);
        trigger.classList.add('cv-active');
      } else {
        // Fallback: open file picker
        fileInput.click();
      }
    });

    fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (currentVisualizer) {
        stopCurrencyAnimation();
        currentVisualizer.destroy();
        currentVisualizer = null;
      }
      activateVisualizer(chartArea, file, trigger);
      trigger.classList.add('cv-active');
      fileInput.value = '';
    });

    // --- Drag & Drop support ---
    setupDragDrop(chartArea, (file) => {
      if (currentVisualizer) {
        stopCurrencyAnimation();
        currentVisualizer.destroy();
        currentVisualizer = null;
      }
      activateVisualizer(chartArea, file, trigger);
      trigger.classList.add('cv-active');
    });

    chartArea.appendChild(trigger);
    chartArea.appendChild(fileInput);

    console.log('[ChartVisualizer] ✓ Trigger injected on chart area');
  }

  // ========================================================
  // DRAG & DROP
  // ========================================================

  function setupDragDrop(container, onFile) {
    // Create drop overlay
    const dropOverlay = document.createElement('div');
    dropOverlay.className = 'cv-drop-overlay';
    dropOverlay.innerHTML = `
      <svg viewBox="0 0 24 24" width="36" height="36">
        <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
      </svg>
      <span>Drop audio file here</span>
    `;
    container.appendChild(dropOverlay);

    let dragCounter = 0;

    container.addEventListener('dragenter', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter++;
      if (dragCounter === 1) {
        dropOverlay.classList.add('cv-drop-active');
      }
    });

    container.addEventListener('dragleave', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter--;
      if (dragCounter === 0) {
        dropOverlay.classList.remove('cv-drop-active');
      }
    });

    container.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    container.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter = 0;
      dropOverlay.classList.remove('cv-drop-active');

      const files = e.dataTransfer.files;
      if (files.length > 0 && files[0].type.startsWith('audio/')) {
        onFile(files[0]);
      }
    });
  }

  // ========================================================
  // VISUALIZER ACTIVATION
  // ========================================================

  /**
   * Replace chart with visualizer canvas
   */
  function activateVisualizer(container, file, triggerBtn) {
    // Identify original chart children (everything except our injected elements)
    const ourClasses = ['cv-trigger', 'cv-file-input', 'cv-drop-overlay',
                        'cv-canvas-wrapper', 'cv-song-info', 'cv-progress-bar'];
    const originalChildren = Array.from(container.children).filter(c => {
      return !ourClasses.some(cls => c.classList.contains(cls));
    });

    // Hide original chart content
    originalChildren.forEach(c => {
      c.style.display = 'none';
    });

    // --- Create canvas wrapper ---
    let canvasWrapper = container.querySelector('.cv-canvas-wrapper');
    if (canvasWrapper) canvasWrapper.remove();

    canvasWrapper = document.createElement('div');
    canvasWrapper.className = 'cv-canvas-wrapper';

    // Get dimensions from original chart area
    const rect = container.getBoundingClientRect();
    const displayWidth = rect.width;
    const displayHeight = Math.max(rect.height, 180); // Minimum height

    // Create high-DPI canvas
    const canvas = document.createElement('canvas');
    canvas.className = 'cv-canvas';
    const dpr = window.devicePixelRatio || 1;
    canvas.width = displayWidth * dpr;
    canvas.height = displayHeight * dpr;
    canvas.style.width = displayWidth + 'px';
    canvas.style.height = displayHeight + 'px';

    canvasWrapper.appendChild(canvas);

    // --- Mode indicator ---
    const modeIndicator = document.createElement('div');
    modeIndicator.className = 'cv-mode-indicator';
    modeIndicator.textContent = 'WAVE';
    canvasWrapper.appendChild(modeIndicator);

    // --- Song info ---
    const songInfo = document.createElement('div');
    songInfo.className = 'cv-song-info';
    songInfo.textContent = file.name.replace(/\.[^.]+$/, '');

    // --- Progress bar ---
    const progressBar = document.createElement('div');
    progressBar.className = 'cv-progress-bar';
    const progressFill = document.createElement('div');
    progressFill.className = 'cv-progress-fill';
    progressBar.appendChild(progressFill);

    // Insert elements
    container.insertBefore(canvasWrapper, container.firstChild);
    canvasWrapper.appendChild(songInfo);
    canvasWrapper.appendChild(progressBar);

    // --- Initialize visualizer ---
    currentVisualizer = new AudioVisualizer(canvas, {
      mode: 'wave',
      sensitivity: currentSensitivity,
      waveBaseline: currentBaseline,
      waveSmoothFactor: currentSmoothFactor,
      colors: {
        primary: '#81c995',
        primaryRgb: '129, 201, 149',
        secondary: '#8ab4f8',
        secondaryRgb: '138, 180, 248',
        background: '#202124',
        glow: 'rgba(129, 201, 149, 0.4)',
        grid: 'rgba(255, 255, 255, 0.06)'
      }
    });

    // Set internal draw dimensions
    currentVisualizer._drawWidth = displayWidth;
    currentVisualizer._drawHeight = displayHeight;

    // Scale context for DPI
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    // Progress callback
    currentVisualizer.onProgress = (pct) => {
      progressFill.style.width = pct + '%';
    };

    // Ended callback — restore chart
    currentVisualizer.onEnded = () => {
      stopCurrencyAnimation();
      triggerBtn.classList.remove('cv-active');
    };

    // Load and play
    currentVisualizer.loadFile(file).then(() => {
      startCurrencyAnimation(container);
    }).catch(err => {
      console.error('[ChartVisualizer] Playback error:', err);
    });

    // --- Click canvas to cycle modes ---
    const modes = ['wave', 'wave-bt', 'bars', 'circle'];
    const modeLabels = {
      'wave': 'WAVE',
      'wave-bt': 'BASS / TREBLE',
      'bars': 'BARS',
      'circle': 'CIRCLE'
    };
    canvas.addEventListener('click', () => {
      if (!currentVisualizer) return;
      const idx = modes.indexOf(currentVisualizer.mode);
      const nextMode = modes[(idx + 1) % modes.length];
      currentVisualizer.setMode(nextMode);

      modeIndicator.textContent = modeLabels[nextMode] || nextMode.toUpperCase();
      modeIndicator.classList.remove('cv-mode-flash');
      void modeIndicator.offsetWidth;
      modeIndicator.classList.add('cv-mode-flash');
    });

    console.log('[ChartVisualizer] ✓ Visualizer activated for:', file.name);
  }

  // ========================================================
  // INITIALIZATION
  // ========================================================

  /**
   * Main initialization - find chart and inject trigger
   */
  function init() {
    if (injected) return;

    const container = findCurrencyContainer();
    if (!container) return;

    const chartArea = findChartArea(container);
    if (!chartArea) return;

    injectTrigger(chartArea);
  }

  // --- MutationObserver for dynamically loaded charts ---
  const observer = new MutationObserver((mutations) => {
    if (injected) return;

    // Only check if new nodes were added
    for (const mutation of mutations) {
      if (mutation.addedNodes.length > 0) {
        init();
        break;
      }
    }
  });

  // Start observing
  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // Try immediately
  init();

  // Retry after delays (chart may load async)
  setTimeout(init, 500);
  setTimeout(init, 1500);
  setTimeout(init, 3000);
  setTimeout(init, 5000);

  // --- Handle Google SPA navigation ---
  // Google uses History API for navigation between searches
  let lastUrl = location.href;

  const urlObserver = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      // Reset state for new search
      if (currentVisualizer) {
        stopCurrencyAnimation();
        currentVisualizer.destroy();
        currentVisualizer = null;
      }
      injected = false;
      chartContainer = null;
      // Re-init after navigation
      setTimeout(init, 500);
      setTimeout(init, 1500);
      setTimeout(init, 3000);
    }
  });

  urlObserver.observe(document.body, { childList: true, subtree: true });

  console.log('[ChartVisualizer] ✓ Extension loaded, watching for currency charts...');
})();
