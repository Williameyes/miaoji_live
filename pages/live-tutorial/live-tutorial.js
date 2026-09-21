/**
 * @fileoverview 0门槛直播教程页面逻辑
 * 硬件准备、开播五步走、常见说明及联系客服索取视频教程
 */

Page({
  data: {
    showContactModal: false
  },

  onLoad() {},

  /**
   * 打开联系客服确认弹窗
   */
  openContactModal() {
    this.setData({ showContactModal: true });
  },

  /**
   * 关闭联系客服确认弹窗
   */
  closeContactModal() {
    this.setData({ showContactModal: false });
  },

  /**
   * 阻止弹窗点击冒泡
   */
  stopContactModalBubble() {},

  /**
   * 阻止弹窗背景滑动穿透
   */
  onContactModalCatchMove() {},

  /**
   * 用户点击右上角分享给朋友
   */
  onShareAppMessage() {
    return {
      title: '手机开播其实超简单！0门槛赛事实时直播教程',
      path: '/pages/live-tutorial/live-tutorial'
    };
  },

  /**
   * 用户点击右上角分享到朋友圈
   */
  onShareTimeline() {
    return {
      title: '手机开播其实超简单！0门槛赛事实时直播教程'
    };
  }
});
