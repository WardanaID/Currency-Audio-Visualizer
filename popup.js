// Popup script — Music preload + Settings sliders
document.addEventListener('DOMContentLoaded', () => {
  // --- Elements ---
  const chooseFileBtn = document.getElementById('chooseFileBtn');
  const musicFileInput = document.getElementById('musicFileInput');
  const fileStatus = document.getElementById('fileStatus');
  const clearFileBtn = document.getElementById('clearFileBtn');

  const sensitivitySlider = document.getElementById('sensitivitySlider');
  const sensitivityValue = document.getElementById('sensitivityValue');
  const baselineSlider = document.getElementById('baselineSlider');
  const baselineValue = document.getElementById('baselineValue');
  const speedSlider = document.getElementById('speedSlider');
  const speedValue = document.getElementById('speedValue');

  const animateNumberCheckbox = document.getElementById('animateNumberCheckbox');
  const numberSpeedSlider = document.getElementById('numberSpeedSlider');
  const numberSpeedValue = document.getElementById('numberSpeedValue');
  const numberSpeedRow = document.getElementById('numberSpeedRow');

  // --- Load saved settings ---
  chrome.storage.local.get({
    sensitivity: 2.0,
    waveBaseline: 1.0,
    waveSmoothFactor: 0.10,
    animateNumber: true,
    numberSpeed: 0.2,
    preloadedAudioName: null,
    preloadedAudioSize: null
  }, (result) => {
    // Sensitivity
    sensitivitySlider.value = result.sensitivity;
    sensitivityValue.textContent = result.sensitivity.toFixed(1) + '×';

    // Baseline
    baselineSlider.value = result.waveBaseline;
    baselineValue.textContent = result.waveBaseline.toFixed(2);

    // Speed
    speedSlider.value = result.waveSmoothFactor;
    speedValue.textContent = result.waveSmoothFactor.toFixed(2);

    // Animate Number Toggle
    animateNumberCheckbox.checked = result.animateNumber;
    if (result.animateNumber) {
      numberSpeedRow.classList.remove('disabled');
    } else {
      numberSpeedRow.classList.add('disabled');
    }

    // Number Speed
    numberSpeedSlider.value = result.numberSpeed;
    numberSpeedValue.textContent = result.numberSpeed.toFixed(1) + '%/s';

    // Music file status
    if (result.preloadedAudioName) {
      const name = result.preloadedAudioName;
      const sizeMB = result.preloadedAudioSize
        ? (result.preloadedAudioSize / 1024 / 1024).toFixed(1) + ' MB'
        : '';
      fileStatus.textContent = '✓ ' + truncateName(name) + (sizeMB ? '  (' + sizeMB + ')' : '');
      fileStatus.classList.add('loaded');
      clearFileBtn.classList.add('visible');
    }
  });

  // --- Music Preload ---
  chooseFileBtn.addEventListener('click', () => musicFileInput.click());

  musicFileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    fileStatus.textContent = 'Loading...';
    fileStatus.className = 'file-status loading';
    clearFileBtn.classList.remove('visible');
    chooseFileBtn.disabled = true;

    const reader = new FileReader();
    reader.onload = () => {
      chrome.storage.local.set({
        preloadedAudio: reader.result,
        preloadedAudioName: file.name,
        preloadedAudioType: file.type,
        preloadedAudioSize: file.size
      }, () => {
        const sizeMB = (file.size / 1024 / 1024).toFixed(1) + ' MB';
        fileStatus.textContent = '✓ ' + truncateName(file.name) + '  (' + sizeMB + ')';
        fileStatus.className = 'file-status loaded';
        clearFileBtn.classList.add('visible');
        chooseFileBtn.disabled = false;
      });
    };
    reader.onerror = () => {
      fileStatus.textContent = '✕ Failed to load';
      fileStatus.className = 'file-status';
      chooseFileBtn.disabled = false;
    };
    reader.readAsDataURL(file);
  });

  clearFileBtn.addEventListener('click', () => {
    chrome.storage.local.remove([
      'preloadedAudio', 'preloadedAudioName',
      'preloadedAudioType', 'preloadedAudioSize'
    ], () => {
      fileStatus.textContent = 'No file loaded';
      fileStatus.className = 'file-status';
      clearFileBtn.classList.remove('visible');
    });
  });

  // --- Slider Handlers ---
  function bindSlider(slider, display, key, formatter) {
    slider.addEventListener('input', () => {
      const val = parseFloat(slider.value);
      display.textContent = formatter(val);
      chrome.storage.local.set({ [key]: val });
    });
  }

  bindSlider(sensitivitySlider, sensitivityValue, 'sensitivity', v => v.toFixed(1) + '×');
  bindSlider(baselineSlider, baselineValue, 'waveBaseline', v => v.toFixed(2));
  bindSlider(speedSlider, speedValue, 'waveSmoothFactor', v => v.toFixed(2));
  bindSlider(numberSpeedSlider, numberSpeedValue, 'numberSpeed', v => v.toFixed(1) + '%/s');

  animateNumberCheckbox.addEventListener('change', () => {
    const active = animateNumberCheckbox.checked;
    if (active) {
      numberSpeedRow.classList.remove('disabled');
    } else {
      numberSpeedRow.classList.add('disabled');
    }
    chrome.storage.local.set({ animateNumber: active });
  });

  // --- Helpers ---
  function truncateName(name) {
    const base = name.replace(/\.[^.]+$/, '');
    return base.length > 22 ? base.substring(0, 20) + '…' : base;
  }
});
