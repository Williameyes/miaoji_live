const SAFE_BALANCED = 'SAFE_BALANCED';
const SAFE_BALANCED_APPLY_PRESET = 'OUTDOOR_NORMAL';

const PRESET_LABELS = {
  SAFE_BALANCED: '安全平衡',
  OUTDOOR_NORMAL: '户外标准',
  OUTDOOR_BRIGHT: '户外强光',
  OUTDOOR_CLOUDY: '户外阴天',
  OUTDOOR_BACKLIGHT: '户外逆光',
  INDOOR_NORMAL: '室内标准',
  INDOOR_DARK: '室内偏暗',
  INDOOR_LED: '室内 LED',
  INDOOR_BACKLIGHT: '室内逆光',
  FAST_MOTION: '高速运动',
  STATIC_SCENE: '静态画面'
};

function round(value, digits) {
  var factor = Math.pow(10, digits || 3);
  return Math.round(Number(value || 0) * factor) / factor;
}

function mean(values) {
  if (!Array.isArray(values) || values.length < 1) return 0;
  var sum = 0;
  for (var i = 0; i < values.length; i++) sum += Number(values[i] || 0);
  return sum / values.length;
}

function variance(values, avg) {
  if (!Array.isArray(values) || values.length < 1) return 0;
  var m = typeof avg === 'number' ? avg : mean(values);
  var sum = 0;
  for (var i = 0; i < values.length; i++) {
    var diff = Number(values[i] || 0) - m;
    sum += diff * diff;
  }
  return sum / values.length;
}

function meanDelta(values) {
  if (!Array.isArray(values) || values.length < 2) return 0;
  var sum = 0;
  var count = 0;
  for (var i = 1; i < values.length; i++) {
    sum += Math.abs(Number(values[i] || 0) - Number(values[i - 1] || 0));
    count++;
  }
  return count > 0 ? (sum / count) : 0;
}

function analyzeFrameStats(frameStats) {
  var frames = Array.isArray(frameStats) ? frameStats.filter(Boolean) : [];
  if (frames.length < 4) {
    return {
      preset: SAFE_BALANCED,
      applyPreset: SAFE_BALANCED_APPLY_PRESET,
      autoAdjustOffset: { tone: 0, amount: 0, motion: 0 },
      confidence: 0.42,
      finalStats: { sampleCount: frames.length },
      scores: {},
      reason: 'insufficient_samples'
    };
  }

  var brightnessList = [];
  var highlightList = [];
  var darkList = [];
  var contrastList = [];
  var avgRList = [];
  var avgGList = [];
  var avgBList = [];
  for (var i = 0; i < frames.length; i++) {
    var item = frames[i];
    brightnessList.push(Number(item.brightness || 0));
    highlightList.push(Number(item.highlightRatio || 0));
    darkList.push(Number(item.darkRatio || 0));
    contrastList.push(Number(item.contrast || 0));
    avgRList.push(Number(item.avgR || 0));
    avgGList.push(Number(item.avgG || 0));
    avgBList.push(Number(item.avgB || 0));
  }

  var avgBrightness = mean(brightnessList);
  var avgHighlightRatio = mean(highlightList);
  var avgDarkRatio = mean(darkList);
  var avgContrast = mean(contrastList);
  var brightnessVariance = variance(brightnessList, avgBrightness);
  var contrastVariance = variance(contrastList, avgContrast);
  var brightnessDelta = meanDelta(brightnessList);
  var contrastDelta = meanDelta(contrastList);
  var highlightDelta = meanDelta(highlightList);
  var avgR = mean(avgRList);
  var avgG = mean(avgGList);
  var avgB = mean(avgBList);
  var colorTemperatureTrend = avgB - ((avgR + avgG) * 0.5);
  var motionSwingIndex = brightnessDelta * 0.35 + contrastDelta * 0.45 + highlightDelta * 100;

  var finalStats = {
    sampleCount: frames.length,
    avgBrightness: round(avgBrightness, 3),
    brightnessVariance: round(brightnessVariance, 3),
    highlightRatio: round(avgHighlightRatio, 4),
    darkRatio: round(avgDarkRatio, 4),
    avgContrast: round(avgContrast, 3),
    contrastVariance: round(contrastVariance, 3),
    colorTemperatureTrend: round(colorTemperatureTrend, 3),
    motionSwingIndex: round(motionSwingIndex, 3),
    avgR: round(avgR, 3),
    avgG: round(avgG, 3),
    avgB: round(avgB, 3)
  };

  var scores = {};
  function addScore(name, score) {
    if (!scores[name]) scores[name] = 0;
    scores[name] += score;
  }

  if (avgBrightness > 200) addScore('OUTDOOR_BRIGHT', 3);
  if (avgBrightness > 210) addScore('OUTDOOR_BRIGHT', 2);
  if (avgHighlightRatio > 0.30) addScore('OUTDOOR_BRIGHT', 3);
  if (avgHighlightRatio > 0.42) addScore('OUTDOOR_BRIGHT', 1);

  if (avgContrast > 72) addScore('OUTDOOR_BACKLIGHT', 2);
  if (contrastVariance > 220) addScore('OUTDOOR_BACKLIGHT', 3);
  if (brightnessVariance > 750) addScore('OUTDOOR_BACKLIGHT', 2);
  if (avgHighlightRatio > 0.20) addScore('OUTDOOR_BACKLIGHT', 1);

  if (avgBrightness < 80) addScore('INDOOR_DARK', 3);
  if (avgBrightness < 65) addScore('INDOOR_DARK', 2);
  if (avgDarkRatio > 0.40) addScore('INDOOR_DARK', 3);
  if (avgDarkRatio > 0.55) addScore('INDOOR_DARK', 1);

  if (colorTemperatureTrend > 10) addScore('INDOOR_LED', 2);
  if ((avgG - avgR) > 8) addScore('INDOOR_LED', 2);
  if (avgHighlightRatio > 0.08 && avgBrightness > 95 && avgBrightness < 190) addScore('INDOOR_LED', 1);

  if (motionSwingIndex > 22) addScore('FAST_MOTION', 2);
  if (motionSwingIndex > 30) addScore('FAST_MOTION', 2);
  if (brightnessDelta > 18 && contrastDelta > 10) addScore('FAST_MOTION', 1);

  if (avgContrast < 42 && brightnessVariance < 220 && avgHighlightRatio < 0.08) addScore('STATIC_SCENE', 2);
  if (motionSwingIndex < 8) addScore('STATIC_SCENE', 2);

  if (avgBrightness >= 90 && avgBrightness <= 170 && avgHighlightRatio < 0.18 && avgDarkRatio < 0.22) addScore('INDOOR_NORMAL', 2);
  if (avgBrightness >= 125 && avgBrightness <= 195 && avgHighlightRatio < 0.26 && contrastVariance < 160) addScore('OUTDOOR_NORMAL', 2);
  if (avgBrightness >= 150 && avgBrightness <= 205 && avgHighlightRatio >= 0.12 && avgHighlightRatio <= 0.30) addScore('OUTDOOR_CLOUDY', 2);
  if (avgContrast > 60 && avgDarkRatio > 0.18 && avgHighlightRatio > 0.14) addScore('INDOOR_BACKLIGHT', 2);

  var winner = SAFE_BALANCED;
  var winnerScore = 0;
  var secondScore = 0;
  var scoreKeys = Object.keys(scores);
  for (var s = 0; s < scoreKeys.length; s++) {
    var key = scoreKeys[s];
    var value = scores[key];
    if (value > winnerScore) {
      secondScore = winnerScore;
      winnerScore = value;
      winner = key;
    } else if (value > secondScore) {
      secondScore = value;
    }
  }

  var ambiguous = winnerScore < 4 || (winnerScore - secondScore) <= 1;
  var resultPreset = ambiguous ? SAFE_BALANCED : winner;
  var applyPreset = resultPreset === SAFE_BALANCED ? SAFE_BALANCED_APPLY_PRESET : resultPreset;
  var confidenceBase = ambiguous ? 0.52 : Math.min(0.92, 0.58 + winnerScore * 0.045 + (winnerScore - secondScore) * 0.03);
  var autoAdjustOffset = { tone: 0, amount: 0, motion: 0 };

  if (applyPreset === 'OUTDOOR_BRIGHT') {
    autoAdjustOffset.tone = avgHighlightRatio > 0.38 ? -0.02 : -0.01;
    autoAdjustOffset.motion = motionSwingIndex > 20 ? 0.03 : 0.02;
  } else if (applyPreset === 'OUTDOOR_BACKLIGHT') {
    autoAdjustOffset.tone = -0.015;
    autoAdjustOffset.amount = -0.01;
    autoAdjustOffset.motion = 0.02;
  } else if (applyPreset === 'INDOOR_DARK') {
    autoAdjustOffset.tone = 0.01;
    autoAdjustOffset.amount = 0.02;
    autoAdjustOffset.motion = -0.02;
  } else if (applyPreset === 'INDOOR_LED') {
    autoAdjustOffset.tone = -0.01;
    autoAdjustOffset.amount = 0.01;
  } else if (applyPreset === 'FAST_MOTION') {
    autoAdjustOffset.amount = -0.015;
    autoAdjustOffset.motion = 0.03;
  } else if (applyPreset === 'STATIC_SCENE') {
    autoAdjustOffset.amount = 0.015;
    autoAdjustOffset.motion = -0.02;
  } else if (applyPreset === 'OUTDOOR_CLOUDY') {
    autoAdjustOffset.tone = 0.01;
    autoAdjustOffset.amount = 0.01;
  } else if (applyPreset === 'INDOOR_BACKLIGHT') {
    autoAdjustOffset.tone = -0.01;
    autoAdjustOffset.motion = 0.02;
  }

  return {
    preset: resultPreset,
    applyPreset: applyPreset,
    autoAdjustOffset: autoAdjustOffset,
    confidence: round(confidenceBase, 3),
    finalStats: finalStats,
    scores: scores,
    reason: ambiguous ? 'ambiguous_safe_fallback' : 'score_match',
    label: PRESET_LABELS[resultPreset] || resultPreset,
    applyLabel: PRESET_LABELS[applyPreset] || applyPreset
  };
}

module.exports = {
  analyzeFrameStats: analyzeFrameStats,
  SAFE_BALANCED: SAFE_BALANCED,
  SAFE_BALANCED_APPLY_PRESET: SAFE_BALANCED_APPLY_PRESET,
  PRESET_LABELS: PRESET_LABELS
};
