global.Behavior = function(obj) { return obj; };
global.wx = { getStorageSync: () => ({}), showToast: () => {} };
global.getApp = () => ({ globalData: {} });
try {
  require('./behaviors/footballClockBehavior.js');
  console.log('footballClockBehavior loaded');
} catch(e) { console.error('Error in footballClockBehavior:', e); }
try {
  require('./behaviors/liveWsBehavior.js');
  console.log('liveWsBehavior loaded');
} catch(e) { console.error('Error in liveWsBehavior:', e); }
