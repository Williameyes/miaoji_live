/**
 * @file packageLab/pages/radar-lab/oam/tournament-detail/tournament-detail.js
 * @description 赛事详情与管理看板：赛事概览、快捷业务操作、副管理员团队邀请与管理
 */
const {
  fetchTournamentDetail,
  fetchTournamentCollaborators,
  createTournamentInvite,
  removeTournamentCollaborator,
  oamUpsert
} = require('../../../../../services/tournament-api.js');
const { isRadarWhitelistUser } = require('../../../../utils/radar-access.js');

Page({
  data: {
    tournamentId: null,
    loading: true,
    detail: null,
    isOwner: false,
    isWhitelist: false,
    collaborators: [],
    currentInviteCode: '',

    // 初始基准积分 Modal 相关
    showInitialsModal: false,
    initialGroups: []
  },

  onLoad: function (options) {
    const id = options && (options.id || options.tournament_id);
    if (id) {
      const tourId = Number(id);
      this.tournamentId = tourId;
      this.setData({ tournamentId: tourId });
      this._loadTournamentData(tourId);
    }
  },

  onShow: function () {
    this.setData({
      isWhitelist: isRadarWhitelistUser()
    });
    const tourId = this.tournamentId || this.data.tournamentId;
    if (tourId && this.data.detail) {
      this._loadTournamentData(tourId, true);
    }
  },

  onPullDownRefresh: function () {
    const tourId = this.tournamentId || this.data.tournamentId;
    if (tourId) {
      this._loadTournamentData(tourId, true).finally(function () {
        wx.stopPullDownRefresh();
      });
    } else {
      wx.stopPullDownRefresh();
    }
  },

  onRetryLoad: function () {
    const tourId = this.tournamentId || this.data.tournamentId;
    if (tourId) {
      this._loadTournamentData(tourId);
    }
  },

  _loadTournamentData: function (tourId, silent) {
    const self = this;
    const tournamentId = tourId || this.tournamentId || this.data.tournamentId;
    if (!tournamentId) return Promise.resolve();

    if (!silent) {
      this.setData({ loading: true });
    }

    return Promise.all([
      fetchTournamentDetail(tournamentId),
      fetchTournamentCollaborators(tournamentId).catch(function (err) {
        console.warn('fetchTournamentCollaborators error:', err);
        return { is_owner: false, collaborators: [] };
      })
    ])
      .then(function (results) {
        const detail = results[0];
        const collabData = results[1] || {};
        const isOwner = Boolean(collabData.is_owner);

        if (detail) {
          if (!detail.scheduledCount && Array.isArray(detail.matches)) {
            detail.scheduledCount = detail.matches.length;
          }
          if (detail.monitoredCount === undefined || detail.monitoredCount === null) {
            detail.monitoredCount = Array.isArray(detail.matches)
              ? detail.matches.filter(function (m) {
                  return m.match_status === 'ended' || m.match_status === 'monitoring' || m.match_status === 'live';
                }).length
              : 0;
          }
        }

        self.setData({
          detail: detail,
          isOwner: isOwner,
          collaborators: collabData.collaborators || [],
          loading: false
        });

        // 若当前操作人为创建人，预先生成一个邀请码供微信分享即时使用
        if (isOwner) {
          self._prepareInviteCode(tournamentId);
        }
      })
      .catch(function (err) {
        self.setData({ loading: false });
        if (!silent) {
          wx.showToast({ title: err.message || '加载赛事失败', icon: 'none' });
        }
      });
  },

  _prepareInviteCode: function (tourId) {
    const self = this;
    const tournamentId = tourId || this.tournamentId || this.data.tournamentId;
    if (!tournamentId) return;

    createTournamentInvite(tournamentId)
      .then(function (res) {
        if (res && res.invite_code) {
          self.setData({ currentInviteCode: res.invite_code });
        }
      })
      .catch(function (err) {
        console.warn('prepareInviteCode error:', err);
      });
  },

  // 1. 跳转场次列表
  onGoToMatches: function () {
    const tournamentId = this.data.tournamentId;
    if (!tournamentId) return;
    wx.navigateTo({
      url: '/packageLab/pages/radar-lab/oam/oam?tournament_id=' + encodeURIComponent(tournamentId)
    });
  },

  // 2. 跳转编辑赛事基本信息
  onEditTournamentInfo: function () {
    const tournamentId = this.data.tournamentId;
    if (!tournamentId) return;
    wx.navigateTo({
      url:
        '/packageLab/pages/radar-lab/oam/tournament-edit/tournament-edit?id=' +
        encodeURIComponent(tournamentId)
    });
  },

  // 3. 预览 C 端公开看板
  onPreviewPublicBoard: function () {
    const tournamentId = this.data.tournamentId;
    if (!tournamentId) return;
    wx.navigateTo({
      url:
        '/packagePromo/pages/tournament-detail/tournament-detail?id=' +
        encodeURIComponent(tournamentId)
    });
  },

  // 4. 移除副管理员
  onRemoveCollaborator: function (e) {
    const self = this;
    const openid = e.currentTarget.dataset.openid;
    const name = e.currentTarget.dataset.name || '该副管理员';
    const tournamentId = this.data.tournamentId;

    if (!openid || !tournamentId) return;

    wx.showModal({
      title: '确认移除副管理员',
      content: '确定要将【' + name + '】从赛事副管理员中移除吗？移除后其将无法修改比分与赛程。',
      confirmColor: '#dc2626',
      confirmText: '确认移除',
      cancelText: '取消',
      success: function (res) {
        if (res.confirm) {
          wx.showLoading({ title: '正在移除…' });
          removeTournamentCollaborator(tournamentId, openid)
            .then(function () {
              wx.hideLoading();
              wx.showToast({ title: '已移除副管理员', icon: 'success' });
              self._loadTournamentData(true);
            })
            .catch(function (err) {
              wx.hideLoading();
              wx.showToast({ title: err.message || '移除失败', icon: 'none' });
            });
        }
      }
    });
  },

  // 5. 微信转发分享生成邀请卡片
  onShareAppMessage: function () {
    const self = this;
    const tournamentId = this.data.tournamentId;
    const tourName = (this.data.detail && this.data.detail.name) || '赛事';
    const inviteCode = this.data.currentInviteCode;

    let sharePath =
      '/packagePromo/pages/tournament-detail/tournament-detail?id=' +
      encodeURIComponent(tournamentId);

    if (inviteCode) {
      sharePath += '&invite_code=' + encodeURIComponent(inviteCode);
    }

    // 分享后刷新下一个邀请码凭证
    setTimeout(function () {
      self._prepareInviteCode();
    }, 1000);

    return {
      title: '【邀请协作】诚邀你成为「' + tourName + '」的副管理员',
      path: sharePath,
      imageUrl: (this.data.detail && this.data.detail.coverUrl) || undefined
    };
  },

  // ----------------------------------------------------
  // 基准积分 AI 批量导入 Modal 逻辑
  // ----------------------------------------------------
  onOpenInitialsModal: function () {
    if (!this.data.isWhitelist) {
      wx.showToast({ title: '该功能仅对白名单用户开放', icon: 'none' });
      return;
    }
    const detail = this.data.detail;
    if (!detail) return;

    let stages = [];
    try {
      stages = typeof detail.stages === 'string' ? JSON.parse(detail.stages) : detail.stages;
    } catch (e) {
      stages = [];
    }
    if (!Array.isArray(stages) || stages.length === 0) {
      stages = [
        { id: 'group_a', name: 'A组' },
        { id: 'group_b', name: 'B组' }
      ];
    }

    let existingInitials = {};
    try {
      existingInitials =
        typeof detail.team_initials === 'string'
          ? JSON.parse(detail.team_initials)
          : detail.team_initials || {};
    } catch (e) {
      existingInitials = {};
    }

    const groups = stages.map(function (stg) {
      const sId = stg.id || stg.name;
      const sName = stg.name || stg.id;
      const stageInitials = existingInitials[sId] || {};
      const teams = [];
      const prefix = (sId.split('_')[1] || 'A').toUpperCase();

      for (let i = 1; i <= 6; i += 1) {
        const code = prefix + i;
        const saved = stageInitials[code];
        teams.push({
          teamCode: code,
          actualName: saved ? saved.actual_name || saved.actualName || '' : '',
          basePoints: saved ? String(saved.base_points ?? saved.basePoints ?? '') : ''
        });
      }

      return {
        stageId: sId,
        stageName: sName,
        teams: teams
      };
    });

    this.setData({
      showInitialsModal: true,
      initialGroups: groups
    });
  },

  onCloseInitialsModal: function () {
    this.setData({ showInitialsModal: false });
  },

  onTeamNameInput: function (e) {
    const stageId = e.currentTarget.dataset.stage;
    const code = e.currentTarget.dataset.code;
    const val = e.detail.value;

    const groups = this.data.initialGroups.map(function (grp) {
      if (grp.stageId === stageId) {
        const newTeams = grp.teams.map(function (tm) {
          if (tm.teamCode === code) {
            return Object.assign({}, tm, { actualName: val });
          }
          return tm;
        });
        return Object.assign({}, grp, { teams: newTeams });
      }
      return grp;
    });

    this.setData({ initialGroups: groups });
  },

  onTeamPointsInput: function (e) {
    const stageId = e.currentTarget.dataset.stage;
    const code = e.currentTarget.dataset.code;
    const val = e.detail.value;

    const groups = this.data.initialGroups.map(function (grp) {
      if (grp.stageId === stageId) {
        const newTeams = grp.teams.map(function (tm) {
          if (tm.teamCode === code) {
            return Object.assign({}, tm, { basePoints: val });
          }
          return tm;
        });
        return Object.assign({}, grp, { teams: newTeams });
      }
      return grp;
    });

    this.setData({ initialGroups: groups });
  },

  onCopyAiPrompt: function () {
    const prompt =
      '你是一个专业的赛事数据整理助手。请根据我提供的赛事实时排名或积分表，提取出各小组各队伍的真实名称和当前积分。\n' +
      '请严格输出为以下标准的 JSON 格式，不要包含任何 markdown 标记或解释性文字：\n' +
      '{\n' +
      '  "group_a": {\n' +
      '    "A1": { "actual_name": "战狼队", "base_points": 6 },\n' +
      '    "A2": { "actual_name": "猎鹰队", "base_points": 3 }\n' +
      '  },\n' +
      '  "group_b": {\n' +
      '    "B1": { "actual_name": "宏远队", "base_points": 9 }\n' +
      '  }\n' +
      '}';

    wx.setClipboardData({
      data: prompt,
      success: function () {
        wx.showToast({ title: 'AI 提示词已复制', icon: 'success' });
      }
    });
  },

  onPasteAiJson: function () {
    const self = this;
    wx.getClipboardData({
      success: function (res) {
        const text = res.data;
        if (!text) {
          wx.showToast({ title: '剪贴板内容为空', icon: 'none' });
          return;
        }

        let parsed = null;
        try {
          const match = text.match(/\{[\s\S]*\}/);
          if (match) {
            parsed = JSON.parse(match[0]);
          } else {
            parsed = JSON.parse(text);
          }
        } catch (err) {
          wx.showToast({ title: '无法识别为 JSON 格式', icon: 'none' });
          return;
        }

        if (!parsed || typeof parsed !== 'object') {
          wx.showToast({ title: 'JSON 数据格式有误', icon: 'none' });
          return;
        }

        const groups = self.data.initialGroups.map(function (grp) {
          const stageJson = parsed[grp.stageId] || {};
          const newTeams = grp.teams.map(function (tm) {
            const hit = stageJson[tm.teamCode];
            if (hit) {
              return Object.assign({}, tm, {
                actualName: hit.actual_name || hit.actualName || tm.actualName,
                basePoints:
                  hit.base_points != null || hit.basePoints != null
                    ? String(hit.base_points ?? hit.basePoints)
                    : tm.basePoints
              });
            }
            return tm;
          });
          return Object.assign({}, grp, { teams: newTeams });
        });

        self.setData({ initialGroups: groups });
        wx.showToast({ title: 'AI 文本导入成功', icon: 'success' });
      }
    });
  },

  onSaveInitials: function () {
    const self = this;
    const tournamentId = this.data.tournamentId;
    if (!tournamentId) return;

    const result = {};
    this.data.initialGroups.forEach(function (grp) {
      const stageMap = {};
      let hasData = false;
      grp.teams.forEach(function (tm) {
        const name = String(tm.actualName || '').trim();
        const pts = tm.basePoints !== '' ? Number(tm.basePoints) : null;
        if (name || pts !== null) {
          stageMap[tm.teamCode] = {
            actual_name: name,
            base_points: isNaN(pts) ? 0 : pts
          };
          hasData = true;
        }
      });
      if (hasData) {
        result[grp.stageId] = stageMap;
      }
    });

    wx.showLoading({ title: '正在保存…' });
    oamUpsert({
      action: 'upsert_team_initials',
      data: {
        tournament_id: tournamentId,
        team_initials: result
      }
    })
      .then(function () {
        wx.hideLoading();
        wx.showToast({ title: '初始基准积分已保存', icon: 'success' });
        self.onCloseInitialsModal();
        self._loadTournamentData(true);
      })
      .catch(function (err) {
        wx.hideLoading();
        wx.showToast({ title: err.message || '保存失败', icon: 'none' });
      });
  }
});
