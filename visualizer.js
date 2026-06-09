/* ============================================================
   AudioVisualizer - Web Audio API + Canvas Engine
   Uses Google chart color theme for seamless integration
   ============================================================ */

class AudioVisualizer {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.mode = options.mode || 'wave';
    this.colors = options.colors || {
      primary: '#81c995',
      primaryRgb: '129, 201, 149',
      secondary: '#8ab4f8',
      secondaryRgb: '138, 180, 248',
      background: '#202124',
      glow: 'rgba(129, 201, 149, 0.4)',
      grid: 'rgba(255, 255, 255, 0.06)'
    };
    this.audioCtx = null;
    this.analyser = null;
    this.source = null;
    this.audioElement = null;
    this.isPlaying = false;
    this.animationId = null;
    this.rotation = 0;
    this.smoothedWave = [];
    this.smoothedFreq = [];
    this.particles = [];
    this.onProgress = null;
    this.onEnded = null;
    this.fileName = '';
    this._resizeHandler = null;
    this._destroyed = false;
    this.sensitivity = options.sensitivity || 2.0;
    this.waveBaseline = options.waveBaseline !== undefined ? options.waveBaseline : 1.0;
    this.waveSmoothFactor = options.waveSmoothFactor !== undefined ? options.waveSmoothFactor : 0.10;
  }

  /**
   * Load and play an audio file
   */
  async loadFile(file) {
    this.fileName = file.name.replace(/\.[^.]+$/, '');

    // Cleanup previous audio if any
    this._cleanupAudio();

    // Create audio element
    this.audioElement = new Audio();
    this.audioElement.crossOrigin = 'anonymous';
    this.audioElement.src = URL.createObjectURL(file);

    // Create AudioContext (requires user gesture - we have it from click)
    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    // Resume context if suspended
    if (this.audioCtx.state === 'suspended') {
      await this.audioCtx.resume();
    }

    // Create source and analyser
    this.source = this.audioCtx.createMediaElementSource(this.audioElement);
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.82;

    // Connect: source → analyser → destination (speakers)
    this.source.connect(this.analyser);
    this.analyser.connect(this.audioCtx.destination);

    // Initialize smoothed data arrays
    const binCount = this.analyser.frequencyBinCount;
    this.smoothedWave = new Array(binCount).fill(128);
    this.smoothedFreq = new Array(binCount).fill(0);

    // Play
    try {
      await this.audioElement.play();
      this.isPlaying = true;
    } catch (err) {
      console.error('[ChartVisualizer] Playback failed:', err);
      return;
    }

    // Progress tracking
    this.audioElement.addEventListener('timeupdate', () => {
      if (this.onProgress && this.audioElement.duration) {
        const pct = (this.audioElement.currentTime / this.audioElement.duration) * 100;
        this.onProgress(pct);
      }
    });

    // Handle end
    this.audioElement.addEventListener('ended', () => {
      this.isPlaying = false;
      if (this.onEnded) this.onEnded();
    });

    // Handle resize
    this._resizeHandler = () => this._handleResize();
    window.addEventListener('resize', this._resizeHandler);

    // Start render loop
    this._render();
  }

  /**
   * Set visualizer mode
   */
  setMode(mode) {
    this.mode = mode;
    this.rotation = 0;
    this.particles = [];
  }

  /**
   * Toggle play/pause
   */
  togglePlay() {
    if (!this.audioElement) return;
    if (this.audioElement.paused) {
      this.audioElement.play();
      this.isPlaying = true;
    } else {
      this.audioElement.pause();
      this.isPlaying = false;
    }
  }

  /**
   * Handle canvas resize
   */
  _handleResize() {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.ctx.scale(dpr, dpr);
    this.canvas.style.width = rect.width + 'px';
    this.canvas.style.height = rect.height + 'px';
    this._drawWidth = rect.width;
    this._drawHeight = rect.height;
  }

  /**
   * Main render loop
   */
  _render() {
    if (this._destroyed) return;
    this.animationId = requestAnimationFrame(() => this._render());

    if (!this.analyser) return;

    const timeData = new Uint8Array(this.analyser.frequencyBinCount);
    const freqData = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteTimeDomainData(timeData);
    this.analyser.getByteFrequencyData(freqData);

    // Smooth the data — wave modes use configurable speed, others fixed
    const isWaveMode = this.mode === 'wave' || this.mode === 'wave-bt';
    const sf = isWaveMode ? (this.waveSmoothFactor || 0.10) : 0.25;
    for (let i = 0; i < timeData.length; i++) {
      this.smoothedWave[i] += (timeData[i] - this.smoothedWave[i]) * sf;
      this.smoothedFreq[i] += (freqData[i] - this.smoothedFreq[i]) * sf;
    }

    switch (this.mode) {
      case 'wave':
        this._drawWave();
        break;
      case 'wave-bt':
        this._drawWaveBassTreeble();
        break;
      case 'bars':
        this._drawBars();
        break;
      case 'circle':
        this._drawCircle();
        break;
    }
  }

  /**
   * Draw grid lines (Google chart style)
   */
  _drawGrid(width, height) {
    const { ctx, colors } = this;
    ctx.strokeStyle = colors.grid;
    ctx.lineWidth = 1;

    // Horizontal grid lines
    const hLines = 5;
    for (let i = 1; i < hLines; i++) {
      const y = (height / hLines) * i;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    // Subtle vertical grid lines
    const vLines = 8;
    for (let i = 1; i < vLines; i++) {
      const x = (width / vLines) * i;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
  }

  /**
   * WAVE MODE - Baseline at BOTTOM, rises upward with sound
   * Silent = flat line at the bottom (like a stock chart at zero)
   * Sound = wave rises up proportional to amplitude × sensitivity
   */
  _drawWave() {
    const { ctx, colors, smoothedWave, sensitivity } = this;
    const width = this._drawWidth || this.canvas.width;
    const height = this._drawHeight || this.canvas.height;

    // Clear
    ctx.fillStyle = colors.background;
    ctx.fillRect(0, 0, width, height);

    // Grid
    this._drawGrid(width, height);

    // Downsample to smooth points
    const pointCount = 120;
    const step = Math.floor(smoothedWave.length / pointCount);
    const points = [];

    const bottomMargin = 6;
    const baselineRatio = this.waveBaseline !== undefined ? this.waveBaseline : 1.0;
    const baselineY = bottomMargin + (height - bottomMargin * 2) * baselineRatio;
    const maxRise = baselineY - bottomMargin;

    for (let i = 0; i < pointCount; i++) {
      const idx = i * step;
      // Deviation from silence (128 = silent center for time-domain data)
      const deviation = Math.abs(smoothedWave[idx] - 128) / 128.0; // 0..1
      // Scale by sensitivity and clamp
      const amplitude = Math.min(deviation * sensitivity, 1.0);
      const x = (i / (pointCount - 1)) * width;
      // Baseline position configurable, rises upward with amplitude
      const y = baselineY - amplitude * maxRise;
      points.push({ x, y });
    }

    // --- Draw filled area under curve (from line down to bottom) ---
    ctx.beginPath();
    ctx.moveTo(points[0].x, height);
    ctx.lineTo(points[0].x, points[0].y);

    for (let i = 1; i < points.length - 1; i++) {
      const xc = (points[i].x + points[i + 1].x) / 2;
      const yc = (points[i].y + points[i + 1].y) / 2;
      ctx.quadraticCurveTo(points[i].x, points[i].y, xc, yc);
    }

    const last = points[points.length - 1];
    ctx.lineTo(last.x, last.y);
    ctx.lineTo(width, height);
    ctx.closePath();

    const areaGradient = ctx.createLinearGradient(0, 0, 0, height);
    areaGradient.addColorStop(0, `rgba(${colors.primaryRgb}, 0.25)`);
    areaGradient.addColorStop(0.4, `rgba(${colors.primaryRgb}, 0.12)`);
    areaGradient.addColorStop(1, `rgba(${colors.primaryRgb}, 0.03)`);
    ctx.fillStyle = areaGradient;
    ctx.fill();

    // --- Draw the main line ---
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);

    for (let i = 1; i < points.length - 1; i++) {
      const xc = (points[i].x + points[i + 1].x) / 2;
      const yc = (points[i].y + points[i + 1].y) / 2;
      ctx.quadraticCurveTo(points[i].x, points[i].y, xc, yc);
    }

    ctx.lineTo(last.x, last.y);

    ctx.strokeStyle = colors.primary;
    ctx.lineWidth = 2.5;
    ctx.shadowColor = colors.glow;
    ctx.shadowBlur = 12;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // --- Endpoint dot (like Google chart's current value marker) ---
    ctx.beginPath();
    ctx.arc(last.x, last.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = colors.primary;
    ctx.shadowColor = colors.glow;
    ctx.shadowBlur = 8;
    ctx.fill();
    ctx.shadowBlur = 0;

    // White inner dot
    ctx.beginPath();
    ctx.arc(last.x, last.y, 1.5, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();

    // --- Floating particles ---
    this._updateParticles(width, height, points);
  }

  /**
   * WAVE BASS-TREBLE MODE
   * Left side = treble (high freq), Right side = bass (low freq)
   * Uses frequency data for amplitude, drawn from configurable baseline
   */
  _drawWaveBassTreeble() {
    const { ctx, colors, smoothedFreq, sensitivity } = this;
    const width = this._drawWidth || this.canvas.width;
    const height = this._drawHeight || this.canvas.height;

    // Clear
    ctx.fillStyle = colors.background;
    ctx.fillRect(0, 0, width, height);
    this._drawGrid(width, height);

    const pointCount = 120;
    // Only use lower ~50% of bins (above that is mostly inaudible overtones)
    const usefulBins = Math.floor(smoothedFreq.length * 0.5);
    const points = [];

    const bottomMargin = 6;
    const baselineRatio = this.waveBaseline !== undefined ? this.waveBaseline : 1.0;
    const baselineY = bottomMargin + (height - bottomMargin * 2) * baselineRatio;
    const maxRise = baselineY - bottomMargin;

    for (let i = 0; i < pointCount; i++) {
      // i=0 (left) → treble, i=pointCount-1 (right) → bass
      const t = 1 - (i / (pointCount - 1)); // 1 at left, 0 at right
      // Logarithmic mapping for better perceptual distribution
      const freqIdx = Math.floor(Math.pow(t, 1.5) * usefulBins);
      const value = smoothedFreq[freqIdx] || 0;

      // Compensate: treble has less energy, boost it
      const freqGain = 0.6 + t * 1.0; // 0.6 for bass side, 1.6 for treble side
      const amplitude = Math.min((value / 255) * sensitivity * freqGain, 1.0);

      const x = (i / (pointCount - 1)) * width;
      const y = baselineY - amplitude * maxRise;
      points.push({ x, y });
    }

    // --- Filled area ---
    ctx.beginPath();
    ctx.moveTo(points[0].x, height);
    ctx.lineTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length - 1; i++) {
      const xc = (points[i].x + points[i + 1].x) / 2;
      const yc = (points[i].y + points[i + 1].y) / 2;
      ctx.quadraticCurveTo(points[i].x, points[i].y, xc, yc);
    }
    const last = points[points.length - 1];
    ctx.lineTo(last.x, last.y);
    ctx.lineTo(width, height);
    ctx.closePath();

    // Gradient: treble side (left) = blue tint, bass side (right) = green
    const areaGrad = ctx.createLinearGradient(0, 0, width, 0);
    areaGrad.addColorStop(0, `rgba(${colors.secondaryRgb}, 0.18)`);
    areaGrad.addColorStop(0.5, `rgba(${colors.primaryRgb}, 0.12)`);
    areaGrad.addColorStop(1, `rgba(${colors.primaryRgb}, 0.20)`);
    ctx.fillStyle = areaGrad;
    ctx.fill();

    // --- Main line with horizontal gradient ---
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length - 1; i++) {
      const xc = (points[i].x + points[i + 1].x) / 2;
      const yc = (points[i].y + points[i + 1].y) / 2;
      ctx.quadraticCurveTo(points[i].x, points[i].y, xc, yc);
    }
    ctx.lineTo(last.x, last.y);

    const lineGrad = ctx.createLinearGradient(0, 0, width, 0);
    lineGrad.addColorStop(0, colors.secondary);   // treble = blue
    lineGrad.addColorStop(0.5, '#a8d8b9');         // mid blend
    lineGrad.addColorStop(1, colors.primary);      // bass = green
    ctx.strokeStyle = lineGrad;
    ctx.lineWidth = 2.5;
    ctx.shadowColor = colors.glow;
    ctx.shadowBlur = 10;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // --- Labels ---
    ctx.font = '10px "Google Sans", Roboto, sans-serif';
    ctx.fillStyle = `rgba(${colors.secondaryRgb}, 0.4)`;
    ctx.fillText('TREBLE', 8, 16);
    ctx.fillStyle = `rgba(${colors.primaryRgb}, 0.4)`;
    ctx.textAlign = 'right';
    ctx.fillText('BASS', width - 8, 16);
    ctx.textAlign = 'left';

    // --- Endpoint dots ---
    // Left (treble)
    ctx.beginPath();
    ctx.arc(points[0].x + 2, points[0].y, 3, 0, Math.PI * 2);
    ctx.fillStyle = colors.secondary;
    ctx.shadowColor = `rgba(${colors.secondaryRgb}, 0.5)`;
    ctx.shadowBlur = 6;
    ctx.fill();
    ctx.shadowBlur = 0;

    // Right (bass)
    ctx.beginPath();
    ctx.arc(last.x - 2, last.y, 3, 0, Math.PI * 2);
    ctx.fillStyle = colors.primary;
    ctx.shadowColor = colors.glow;
    ctx.shadowBlur = 6;
    ctx.fill();
    ctx.shadowBlur = 0;

    // Particles
    this._updateParticles(width, height, points);
  }

  /**
   * BARS MODE - Frequency bars like an equalizer
   */
  _drawBars() {
    const { ctx, colors, smoothedFreq } = this;
    const width = this._drawWidth || this.canvas.width;
    const height = this._drawHeight || this.canvas.height;

    // Clear
    ctx.fillStyle = colors.background;
    ctx.fillRect(0, 0, width, height);

    // Grid
    this._drawGrid(width, height);

    const barCount = 64;
    const gap = 2;
    const barWidth = (width - gap * (barCount - 1)) / barCount;
    const step = Math.floor(smoothedFreq.length / barCount);

    for (let i = 0; i < barCount; i++) {
      // Average nearby frequencies for smoother bars
      let sum = 0;
      const sampleRange = Math.min(step, 4);
      for (let j = 0; j < sampleRange; j++) {
        sum += smoothedFreq[i * step + j] || 0;
      }
      const value = sum / sampleRange;
      const barHeight = (value / 255) * height * 0.85;

      const x = i * (barWidth + gap);
      const y = height - barHeight;

      // Create gradient for each bar
      const barGrad = ctx.createLinearGradient(x, height, x, y);
      const t = i / barCount; // Position along spectrum

      if (t < 0.5) {
        // Low-mid frequencies: green
        barGrad.addColorStop(0, `rgba(${colors.primaryRgb}, 0.8)`);
        barGrad.addColorStop(1, `rgba(${colors.primaryRgb}, 0.4)`);
      } else {
        // High frequencies: blend to blue
        barGrad.addColorStop(0, `rgba(${colors.primaryRgb}, 0.7)`);
        barGrad.addColorStop(1, `rgba(${colors.secondaryRgb}, 0.5)`);
      }

      ctx.fillStyle = barGrad;

      // Rounded top bars
      const radius = Math.min(barWidth / 2, 3);
      ctx.beginPath();
      ctx.moveTo(x, height);
      ctx.lineTo(x, y + radius);
      ctx.quadraticCurveTo(x, y, x + radius, y);
      ctx.lineTo(x + barWidth - radius, y);
      ctx.quadraticCurveTo(x + barWidth, y, x + barWidth, y + radius);
      ctx.lineTo(x + barWidth, height);
      ctx.closePath();

      ctx.shadowColor = colors.glow;
      ctx.shadowBlur = barHeight > height * 0.3 ? 6 : 2;
      ctx.fill();
      ctx.shadowBlur = 0;

      // Top cap highlight
      if (barHeight > 5) {
        ctx.fillStyle = `rgba(255, 255, 255, 0.15)`;
        ctx.fillRect(x, y, barWidth, 2);
      }
    }
  }

  /**
   * CIRCLE MODE - Radial frequency visualizer
   */
  _drawCircle() {
    const { ctx, colors, smoothedFreq } = this;
    const width = this._drawWidth || this.canvas.width;
    const height = this._drawHeight || this.canvas.height;
    const centerX = width / 2;
    const centerY = height / 2;
    const baseRadius = Math.min(width, height) * 0.22;

    // Clear
    ctx.fillStyle = colors.background;
    ctx.fillRect(0, 0, width, height);

    this.rotation += 0.003;

    const barCount = 180;
    const step = Math.floor(smoothedFreq.length / barCount);

    // --- Outer glow ring ---
    let avgFreq = 0;
    for (let i = 0; i < barCount; i++) {
      avgFreq += smoothedFreq[i * step] || 0;
    }
    avgFreq /= barCount;
    const glowRadius = baseRadius + (avgFreq / 255) * baseRadius * 0.3;

    const outerGlow = ctx.createRadialGradient(centerX, centerY, baseRadius * 0.8, centerX, centerY, glowRadius + 30);
    outerGlow.addColorStop(0, `rgba(${colors.primaryRgb}, 0.03)`);
    outerGlow.addColorStop(1, 'transparent');
    ctx.fillStyle = outerGlow;
    ctx.fillRect(0, 0, width, height);

    // --- Frequency bars radiating outward ---
    for (let i = 0; i < barCount; i++) {
      const value = smoothedFreq[i * step] || 0;
      const barLength = (value / 255) * baseRadius * 0.9;
      const angle = (i / barCount) * Math.PI * 2 + this.rotation;

      const x1 = centerX + Math.cos(angle) * baseRadius;
      const y1 = centerY + Math.sin(angle) * baseRadius;
      const x2 = centerX + Math.cos(angle) * (baseRadius + barLength);
      const y2 = centerY + Math.sin(angle) * (baseRadius + barLength);

      // Color varies along circle
      const t = i / barCount;
      const r = Math.round(129 + (138 - 129) * t);
      const g = Math.round(201 + (180 - 201) * t);
      const b = Math.round(149 + (248 - 149) * t);

      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${0.3 + (value / 255) * 0.7})`;
      ctx.lineWidth = 2;
      ctx.shadowColor = `rgba(${r}, ${g}, ${b}, 0.4)`;
      ctx.shadowBlur = value > 150 ? 8 : 3;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // --- Inner mirror bars (shorter, inside the circle) ---
    for (let i = 0; i < barCount; i += 2) {
      const value = smoothedFreq[i * step] || 0;
      const barLength = (value / 255) * baseRadius * 0.35;
      const angle = (i / barCount) * Math.PI * 2 + this.rotation;

      const x1 = centerX + Math.cos(angle) * (baseRadius - 2);
      const y1 = centerY + Math.sin(angle) * (baseRadius - 2);
      const x2 = centerX + Math.cos(angle) * (baseRadius - barLength);
      const y2 = centerY + Math.sin(angle) * (baseRadius - barLength);

      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.strokeStyle = `rgba(${colors.primaryRgb}, ${0.15 + (value / 255) * 0.3})`;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // --- Center circle with pulsing glow ---
    const innerRadius = baseRadius * 0.35;
    const pulseScale = 1 + (avgFreq / 255) * 0.08;

    // Inner glow
    const innerGlow = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, innerRadius * pulseScale);
    innerGlow.addColorStop(0, `rgba(${colors.primaryRgb}, 0.08)`);
    innerGlow.addColorStop(0.7, `rgba(${colors.primaryRgb}, 0.03)`);
    innerGlow.addColorStop(1, 'transparent');
    ctx.fillStyle = innerGlow;
    ctx.beginPath();
    ctx.arc(centerX, centerY, innerRadius * pulseScale, 0, Math.PI * 2);
    ctx.fill();

    // Center ring
    ctx.beginPath();
    ctx.arc(centerX, centerY, innerRadius * 0.5 * pulseScale, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(${colors.primaryRgb}, 0.2)`;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Outer ring border
    ctx.beginPath();
    ctx.arc(centerX, centerY, baseRadius, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(${colors.primaryRgb}, 0.12)`;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  /**
   * Particle system for wave mode
   */
  _updateParticles(width, height, points) {
    const { ctx, colors } = this;

    // Spawn new particles from high-amplitude points
    if (this.isPlaying && Math.random() < 0.3) {
      const idx = Math.floor(Math.random() * points.length);
      const pt = points[idx];
      // Only spawn from peaks (lower y = higher on screen / further from bottom)
      if (pt.y < height * 0.65) {
        this.particles.push({
          x: pt.x,
          y: pt.y,
          vx: (Math.random() - 0.5) * 0.5,
          vy: -Math.random() * 0.8 - 0.2,
          life: 1.0,
          size: Math.random() * 2 + 1
        });
      }
    }

    // Cap particles
    if (this.particles.length > 40) {
      this.particles = this.particles.slice(-40);
    }

    // Update and draw
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.life -= 0.015;

      if (p.life <= 0) {
        this.particles.splice(i, 1);
        continue;
      }

      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${colors.primaryRgb}, ${p.life * 0.4})`;
      ctx.fill();
    }
  }

  /**
   * Cleanup audio resources
   */
  _cleanupAudio() {
    if (this.audioElement) {
      this.audioElement.pause();
      if (this.audioElement.src) {
        URL.revokeObjectURL(this.audioElement.src);
      }
      this.audioElement.src = '';
      this.audioElement = null;
    }
    if (this.source) {
      try { this.source.disconnect(); } catch (e) {}
      this.source = null;
    }
    if (this.analyser) {
      try { this.analyser.disconnect(); } catch (e) {}
      this.analyser = null;
    }
    if (this.audioCtx) {
      try { this.audioCtx.close(); } catch (e) {}
      this.audioCtx = null;
    }
  }

  /**
   * Destroy visualizer and restore original chart
   */
  destroy() {
    this._destroyed = true;

    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }

    this._cleanupAudio();

    if (this._resizeHandler) {
      window.removeEventListener('resize', this._resizeHandler);
      this._resizeHandler = null;
    }

    this.isPlaying = false;
    this.particles = [];
    this.smoothedWave = [];
    this.smoothedFreq = [];

    // Restore original chart content
    const wrapper = this.canvas.closest('.cv-canvas-wrapper');
    if (wrapper) {
      const container = wrapper.parentElement;
      if (container) {
        wrapper.remove();
        // Remove song info and progress bar
        const songInfo = container.querySelector('.cv-song-info');
        if (songInfo) songInfo.remove();
        const progressBar = container.querySelector('.cv-progress-bar');
        if (progressBar) progressBar.remove();
        // Show original children
        Array.from(container.children).forEach(c => {
          if (!c.classList.contains('cv-trigger') &&
              !c.classList.contains('cv-file-input')) {
            c.style.display = '';
          }
        });
      }
    }
  }
}
