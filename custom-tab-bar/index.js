/**
 * 自定义底部主导航：图标使用 CSS mask + Base64 SVG，避免位图拉伸模糊。
 */
Component({
  data: {
    selected: 0,
    list: [
      {
        pagePath: '/pages/index/index',
        text: '直播记分',
        iconKey: 'score'
      },
      {
        pagePath: '/pages/tournament/tournament',
        text: '赛事资讯',
        iconKey: 'trophy'
      },
      {
        pagePath: '/pages/mine/mine',
        text: '我的',
        iconKey: 'user'
      }
    ]
  },

  lifetimes: {
    attached() {
      this.updateSelectedFromCurrentRoute();
    }
  },

  pageLifetimes: {
    show() {
      this.updateSelectedFromCurrentRoute();
    }
  },

  methods: {
    /**
     * 根据当前页面路由对齐 selected 状态，首帧消除闪烁
     */
    updateSelectedFromCurrentRoute() {
      try {
        const pages = getCurrentPages();
        if (!pages || !pages.length) return;
        const curPage = pages[pages.length - 1];
        if (!curPage || !curPage.route) return;
        const curRoute = '/' + curPage.route;
        const list = this.data.list;
        for (let i = 0; i < list.length; i++) {
          if (list[i].pagePath === curRoute) {
            if (this.data.selected !== i) {
              this.setData({ selected: i });
            }
            break;
          }
        }
      } catch (e) {}
    },

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
