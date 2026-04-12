const { STORAGE_USER_INFO_KEY } = require('./utils/request.js');

App({
  onLaunch: function () {
    try {
      const cached = wx.getStorageSync(STORAGE_USER_INFO_KEY);
      if (cached && typeof cached === 'object') {
        this.globalData.userInfo = cached;
      }
    } catch (e) {
      // 忽略缓存读取异常
    }

    // 初始化文件系统
    const fs = wx.getFileSystemManager();
    const highlightDir = `${wx.env.USER_DATA_PATH}/highlights`;
    
    fs.access({
      path: highlightDir,
      fail: () => {
        fs.mkdir({
          dirPath: highlightDir,
          recursive: true,
          success: () => console.log('Highlight directory created'),
          fail: (err) => console.error('Failed to create highlight directory', err)
        });
      }
    });
  },
  globalData: {
    /** 当前登录用户信息（与本地 userInfo 缓存同步；未登录为 null） */
    userInfo: null,
    matchConfig: {
      matchName: '',
      matchNameColor: '#E64340',
      teamA: { name: '队 A', bgColor: '#E64340', textColor: '#FFFFFF', score: 0 },
      teamB: { name: '队 B', bgColor: '#10AEFF', textColor: '#FFFFFF', score: 0 },
      period: 0 // 0-6: 热身, 一, 二, 三, 四, 加时, 完赛
    },
    periods: ['热身', '第一节', '第二节', '第三节', '第四节', '加时', '完赛']
  }
})