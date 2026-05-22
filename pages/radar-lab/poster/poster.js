/**
 * @fileoverview 赛事影响力战报海报：离屏 Canvas 2D 绘制并保存相册。
 */

const { ensureRadarLabAccess } = require('../../../utils/radar-access.js');
const { fetchTournamentInfluence } = require('../../../services/radar-api.js');
const { readAssets, findTournament } = require('../../../utils/radar-local-store.js');
const { drawInfluencePoster } = require('../../../utils/radar-poster.js');

/** 海报画布逻辑尺寸 */
const POSTER_W = 750;
const POSTER_H = 1200;

Page({
  data: {
    tournaments: [],
    tournamentId: '',
    tournamentName: '',
    loading: false,
    previewPath: '',
    influence: null
  },

  /** @type {WechatMiniprogram.Canvas | null} */
  _offscreenCanvas: null,

  /**
   * 页面加载。
   * @returns {void}
   */
  onLoad: function () {
    if (!ensureRadarLabAccess({ redirectBack: true })) return;
    const assets = readAssets();
    const first = assets.tournaments[0];
    this.setData({
      tournaments: assets.tournaments,
      tournamentId: first ? String(first.id) : '',
      tournamentName: first ? first.name : ''
    });
  },

  /**
   * 选择赛事。
   * @param {WechatMiniprogram.PickerChange} e
   * @returns {void}
   */
  onTournamentPicker: function (e) {
    const idx = Number(e.detail.value);
    const item = this.data.tournaments[idx];
    if (!item) return;
    this.setData({
      tournamentId: String(item.id),
      tournamentName: item.name,
      previewPath: ''
    });
  },

  /**
   * 手动输入赛事 ID。
   * @param {WechatMiniprogram.Input} e
   * @returns {void}
   */
  onTournamentIdInput: function (e) {
    this.setData({ tournamentId: e.detail.value.trim(), previewPath: '' });
  },

  /**
   * 拉取影响力并生成海报。
   * @returns {void}
   */
  onGeneratePoster: function () {
    const self = this;
    const tournamentId = this.data.tournamentId;
    if (!tournamentId) {
      wx.showToast({ title: '请选择或输入赛事 ID', icon: 'none' });
      return;
    }
    this.setData({ loading: true });
    fetchTournamentInfluence(tournamentId)
      .then(function (res) {
        const local = findTournament(tournamentId);
        const posterData = {
          tournamentName:
            (typeof res.tournament_name === 'string' && res.tournament_name) ||
            (local && local.name) ||
            '精彩赛事',
          totalViewersRecap: res.total_viewers_recap || res.totalViewersRecap || '—',
          peakUserCount: res.peak_user_count || res.peakUserCount || '—',
          influenceScore: res.influence_score || res.influenceScore || '—',
          subtitle: '雷达无缝护航 · 全网热度汇总'
        };
        self.setData({ influence: posterData });
        return self._renderPosterToFile(posterData);
      })
      .then(function (path) {
        self.setData({ previewPath: path });
        wx.showToast({ title: '海报已生成', icon: 'success' });
      })
      .catch(function (err) {
        wx.showToast({ title: err.message || '生成失败', icon: 'none' });
      })
      .finally(function () {
        self.setData({ loading: false });
      });
  },

  /**
   * 离屏 Canvas 绘制并导出临时文件。
   * @param {Object} posterData
   * @returns {Promise<string>}
   */
  _renderPosterToFile: function (posterData) {
    const self = this;
    return new Promise(function (resolve, reject) {
      const query = wx.createSelectorQuery();
      query
        .select('#posterCanvas')
        .fields({ node: true, size: true })
        .exec(function (res) {
          const item = res && res[0];
          if (!item || !item.node) {
            reject(new Error('Canvas 初始化失败'));
            return;
          }
          const canvas = item.node;
          const ctx = canvas.getContext('2d');
          const dpr = wx.getSystemInfoSync().pixelRatio || 2;
          canvas.width = POSTER_W * dpr;
          canvas.height = POSTER_H * dpr;
          ctx.scale(dpr, dpr);
          drawInfluencePoster(ctx, POSTER_W, POSTER_H, posterData);
          wx.canvasToTempFilePath({
            canvas: canvas,
            fileType: 'png',
            quality: 1,
            success: function (out) {
              resolve(out.tempFilePath);
            },
            fail: function (err) {
              reject(new Error((err && err.errMsg) || '导出失败'));
            }
          });
        });
    });
  },

  /**
   * 保存海报到相册。
   * @returns {void}
   */
  onSavePoster: function () {
    const path = this.data.previewPath;
    if (!path) {
      wx.showToast({ title: '请先生成海报', icon: 'none' });
      return;
    }
    wx.saveImageToPhotosAlbum({
      filePath: path,
      success: function () {
        wx.showToast({ title: '已保存到相册', icon: 'success' });
      },
      fail: function (err) {
        const msg = err && err.errMsg ? err.errMsg : '';
        if (msg.indexOf('auth deny') >= 0 || msg.indexOf('authorize') >= 0) {
          wx.showModal({
            title: '需要相册权限',
            content: '请在设置中允许保存到相册',
            confirmText: '去设置',
            success: function (res) {
              if (res.confirm) wx.openSetting({});
            }
          });
          return;
        }
        wx.showToast({ title: '保存失败', icon: 'none' });
      }
    });
  }
});
