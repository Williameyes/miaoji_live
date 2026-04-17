/**
 * 自定义底部主导航：图标使用 CSS mask + Base64 SVG，避免位图拉伸模糊。
 */
Component({
  data: {
    selected: 0,
    list: [
      {
        pagePath: '/pages/index/index',
        text: '记分',
        iconKey: 'score'
      },
      {
        pagePath: '/pages/mine/mine',
        text: '我的',
        iconKey: 'user'
      }
    ]
  },

  methods: {
    /**
     * 切换 Tab 页面
     * @param {WechatMiniprogram.TouchEvent} e
     */
    switchTab(e) {
      const { pagePath, index } = e.currentTarget.dataset;
      const idx = typeof index === 'number' ? index : parseInt(index, 10);
      if (pagePath) {
        wx.switchTab({ url: pagePath });
      }
      if (!Number.isNaN(idx)) {
        this.setData({ selected: idx });
      }
    }
  }
});
