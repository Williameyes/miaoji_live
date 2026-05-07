const SAFE_RANGE = {
  tone: { min: 0.80, max: 0.95 },
  amount: { min: 0.45, max: 0.65 },
  motion: { min: 0.60, max: 0.82 }
};

const PRESET_META = [
  { name: 'OUTDOOR_NORMAL', label: '户外标准' },
  { name: 'OUTDOOR_BRIGHT', label: '户外强光' },
  { name: 'OUTDOOR_CLOUDY', label: '户外阴天' },
  { name: 'OUTDOOR_BACKLIGHT', label: '户外逆光' },
  { name: 'INDOOR_NORMAL', label: '室内标准' },
  { name: 'INDOOR_DARK', label: '室内偏暗' },
  { name: 'INDOOR_LED', label: '室内 LED' },
  { name: 'INDOOR_BACKLIGHT', label: '室内逆光' },
  { name: 'FAST_MOTION', label: '高速运动' },
  { name: 'STATIC_SCENE', label: '静态画面' }
];

const PRESETS = {
  OUTDOOR_NORMAL: { tone: 0.88, amount: 0.50, motion: 0.72 },
  OUTDOOR_BRIGHT: { tone: 0.84, amount: 0.48, motion: 0.70 },
  OUTDOOR_CLOUDY: { tone: 0.91, amount: 0.54, motion: 0.71 },
  OUTDOOR_BACKLIGHT: { tone: 0.93, amount: 0.57, motion: 0.69 },
  INDOOR_NORMAL: { tone: 0.89, amount: 0.53, motion: 0.70 },
  INDOOR_DARK: { tone: 0.94, amount: 0.60, motion: 0.66 },
  INDOOR_LED: { tone: 0.87, amount: 0.56, motion: 0.68 },
  INDOOR_BACKLIGHT: { tone: 0.92, amount: 0.58, motion: 0.67 },
  FAST_MOTION: { tone: 0.86, amount: 0.49, motion: 0.80 },
  STATIC_SCENE: { tone: 0.90, amount: 0.58, motion: 0.62 }
};

const DEFAULT_PRESET = 'OUTDOOR_NORMAL';
const DEFAULT_DURATION_MS = 280;
const TICK_MS = 16;

function clampValue(key, value) {
  const range = SAFE_RANGE[key];
  if (!range) return Number(value) || 0;
  const num = Number(value);
  if (!isFinite(num)) return range.min;
  return Math.max(range.min, Math.min(range.max, num));
}

function roundValue(value) {
  return Math.round(Number(value || 0) * 1000) / 1000;
}

function easeOutCubic(t) {
  const x = Math.max(0, Math.min(1, t));
  return 1 - Math.pow(1 - x, 3);
}

function cloneConfig(config) {
  return {
    tone: roundValue(config.tone),
    amount: roundValue(config.amount),
    motion: roundValue(config.motion)
  };
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

class VKPresetManager {
  constructor(options) {
    const opts = options || {};
    this.presets = Object.assign({}, PRESETS);
    this.presetMeta = PRESET_META.slice();
    this.currentPreset = DEFAULT_PRESET;
    this.autoAdjustOffset = { tone: 0, amount: 0, motion: 0 };
    this.manualOffset = { tone: 0, amount: 0, motion: 0 };
    this.runtimeConfig = cloneConfig(this.presets[this.currentPreset]);
    this.durationMs = Math.max(200, Math.min(500, Number(opts.durationMs) || DEFAULT_DURATION_MS));
    this.onUpdate = typeof opts.onUpdate === 'function' ? opts.onUpdate : null;
    this._timer = null;
    this._anim = null;
  }

  destroy() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this._anim = null;
  }

  getPresetOptions() {
    return this.presetMeta.map((item) => ({ name: item.name, label: item.label }));
  }

  getPresetLabel(name) {
    const found = this.presetMeta.find((item) => item.name === name);
    return found ? found.label : name;
  }

  getPresetConfig(name) {
    const presetName = this.presets[name] ? name : DEFAULT_PRESET;
    return cloneConfig(this.presets[presetName]);
  }

  getManualOffset() {
    return Object.assign({}, this.manualOffset);
  }

  getAutoAdjustOffset() {
    return Object.assign({}, this.autoAdjustOffset);
  }

  getFinalConfig() {
    const base = this.getPresetConfig(this.currentPreset);
    return {
      tone: clampValue('tone', base.tone + this.autoAdjustOffset.tone + this.manualOffset.tone),
      amount: clampValue('amount', base.amount + this.autoAdjustOffset.amount + this.manualOffset.amount),
      motion: clampValue('motion', base.motion + this.autoAdjustOffset.motion + this.manualOffset.motion)
    };
  }

  getSnapshot() {
    const preset = this.getPresetConfig(this.currentPreset);
    const finalConfig = this.getFinalConfig();
    return {
      currentPreset: this.currentPreset,
      currentPresetLabel: this.getPresetLabel(this.currentPreset),
      preset,
      finalConfig: cloneConfig(finalConfig),
      runtimeConfig: cloneConfig(this.runtimeConfig),
      autoAdjustOffset: {
        tone: roundValue(this.autoAdjustOffset.tone),
        amount: roundValue(this.autoAdjustOffset.amount),
        motion: roundValue(this.autoAdjustOffset.motion)
      },
      manualOffset: {
        tone: roundValue(this.manualOffset.tone),
        amount: roundValue(this.manualOffset.amount),
        motion: roundValue(this.manualOffset.motion)
      }
    };
  }

  applyPreset(name) {
    if (!this.presets[name]) return this.getSnapshot();
    this.currentPreset = name;
    this._animateTo(this.getFinalConfig());
    return this.getSnapshot();
  }

  applyRecommendedPreset(name, autoAdjustOffset) {
    if (!this.presets[name]) return this.getSnapshot();
    this.currentPreset = name;
    const next = autoAdjustOffset || {};
    this.autoAdjustOffset = {
      tone: roundValue(Number(next.tone || 0)),
      amount: roundValue(Number(next.amount || 0)),
      motion: roundValue(Number(next.motion || 0))
    };
    this._animateTo(this.getFinalConfig());
    return this.getSnapshot();
  }

  restorePreset() {
    this.manualOffset = { tone: 0, amount: 0, motion: 0 };
    this._animateTo(this.getFinalConfig());
    return this.getSnapshot();
  }

  restoreRecommendedPreset(name, autoAdjustOffset) {
    if (!this.presets[name]) return this.restorePreset();
    this.currentPreset = name;
    const next = autoAdjustOffset || {};
    this.autoAdjustOffset = {
      tone: roundValue(Number(next.tone || 0)),
      amount: roundValue(Number(next.amount || 0)),
      motion: roundValue(Number(next.motion || 0))
    };
    this.manualOffset = { tone: 0, amount: 0, motion: 0 };
    this._animateTo(this.getFinalConfig());
    return this.getSnapshot();
  }

  setAutoAdjustOffset(offset) {
    const next = offset || {};
    this.autoAdjustOffset = {
      tone: roundValue(Number(next.tone || 0)),
      amount: roundValue(Number(next.amount || 0)),
      motion: roundValue(Number(next.motion || 0))
    };
    this._animateTo(this.getFinalConfig());
    return this.getSnapshot();
  }

  setManualValue(key, finalValue) {
    if (!SAFE_RANGE[key]) return this.getSnapshot();
    const base = this.getPresetConfig(this.currentPreset);
    const auto = this.autoAdjustOffset[key] || 0;
    const clampedFinal = clampValue(key, finalValue);
    this.manualOffset[key] = roundValue(clampedFinal - base[key] - auto);
    this._animateTo(this.getFinalConfig());
    return this.getSnapshot();
  }

  _emitUpdate() {
    if (!this.onUpdate) return;
    this.onUpdate(this.getSnapshot());
  }

  _animateTo(targetConfig) {
    const target = cloneConfig(targetConfig);
    const from = cloneConfig(this.runtimeConfig);
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this._anim = {
      startAt: Date.now(),
      from,
      target
    };
    this._tickAnimation();
  }

  _tickAnimation() {
    if (!this._anim) return;
    const now = Date.now();
    const elapsed = now - this._anim.startAt;
    const progress = this.durationMs <= 0 ? 1 : Math.min(1, elapsed / this.durationMs);
    const eased = easeOutCubic(progress);
    this.runtimeConfig = {
      tone: roundValue(lerp(this._anim.from.tone, this._anim.target.tone, eased)),
      amount: roundValue(lerp(this._anim.from.amount, this._anim.target.amount, eased)),
      motion: roundValue(lerp(this._anim.from.motion, this._anim.target.motion, eased))
    };
    this._emitUpdate();
    if (progress >= 1) {
      this.runtimeConfig = cloneConfig(this._anim.target);
      this._anim = null;
      this._timer = null;
      this._emitUpdate();
      return;
    }
    const self = this;
    this._timer = setTimeout(function () {
      self._tickAnimation();
    }, TICK_MS);
  }
}

module.exports = {
  VKPresetManager,
  VK_PRESET_OPTIONS: PRESET_META.slice(),
  VK_PRESET_SAFE_RANGE: SAFE_RANGE
};
