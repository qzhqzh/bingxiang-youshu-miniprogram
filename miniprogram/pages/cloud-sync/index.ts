import { appService } from '../../services/app.service';
import { cloudSyncService } from '../../services/cloud/cloud-sync.service';
import type { MigrationSummary } from '../../v2/models';

Page({
  data: {
    loading: true,
    busy: false,
    error: '',
    status: null as any,
    lastSyncText: '尚未同步',
  },

  onShow() { this.load(); },

  load() {
    const status = cloudSyncService.status();
    this.setData({
      status,
      loading: false,
      lastSyncText: status.lastSyncedAt ? this.formatTime(status.lastSyncedAt) : '尚未同步',
    });
  },

  formatTime(timestamp: number): string {
    const date = new Date(timestamp);
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  },

  enableCloud() {
    if (!cloudSyncService.available()) {
      wx.showModal({
        title: '云同步尚未开放',
        content: '2.0 的本地数据隔离、同步协议和服务端已经进入开发阶段。完成正式 API 域名与数据库部署后才会开放；当前版本仍完整保存在本机。',
        showCancel: false,
      });
      return;
    }
    wx.showModal({
      title: '开启家庭云同步？',
      content: '开启后会使用微信身份登录。只有在下一步再次确认后，本机库存、做菜记录、食谱进度和购物清单才会迁移到所选家庭；不会自动上传。',
      confirmText: '继续',
      confirmColor: '#24564A',
      success: (choice: { confirm: boolean }) => { if (choice.confirm) void this.signInAndPrepare(); },
    });
  },

  async signInAndPrepare() {
    this.setData({ busy: true, error: '' });
    try {
      await cloudSyncService.signIn();
      const summary = await cloudSyncService.prepareMigration(appService.exportJson());
      this.setData({ busy: false });
      this.confirmMigration(summary);
    } catch (error) {
      this.setData({ busy: false, error: error instanceof Error ? error.message : '暂时无法开启云同步' });
      this.load();
    }
  },

  confirmMigration(summary: MigrationSummary) {
    wx.showModal({
      title: '确认迁移本机数据',
      content: `已通过校验：${summary.batchCount} 个食材批次、${summary.cookingRecordCount} 条做菜记录、${summary.shoppingItemCount} 个购物项。确认后才会写入“${cloudSyncService.status().activeHouseholdName}”。`,
      confirmText: '确认迁移',
      confirmColor: '#24564A',
      success: (choice: { confirm: boolean }) => { if (choice.confirm) void this.commitMigration(summary); else this.load(); },
    });
  },

  async commitMigration(summary: MigrationSummary) {
    this.setData({ busy: true, error: '' });
    try {
      await cloudSyncService.commitMigration(summary);
      wx.showToast({ title: '迁移完成', icon: 'success' });
      this.load();
    } catch (error) {
      this.setData({ busy: false, error: error instanceof Error ? error.message : '迁移失败，本机数据未删除' });
    }
  },

  async syncNow() {
    this.setData({ busy: true, error: '' });
    try {
      const result = await cloudSyncService.syncNow();
      wx.showToast({ title: result.offline ? '操作已留在本机' : '同步完成', icon: result.offline ? 'none' : 'success' });
      this.load();
    } catch (error) {
      this.setData({ busy: false, error: error instanceof Error ? error.message : '同步失败' });
    }
  },

  signOut() {
    wx.showModal({
      title: '退出云同步？',
      content: '只会退出当前设备的云端会话，不会删除本机数据或家庭云端数据。',
      confirmText: '确认退出',
      success: (choice: { confirm: boolean }) => {
        if (!choice.confirm) return;
        this.setData({ busy: true });
        cloudSyncService.signOut().then(() => this.load()).catch(() => this.load());
      },
    });
  },
});
