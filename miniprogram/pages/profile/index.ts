import { appService } from '../../services/app.service';

Page({
  data: {
    loading: true, error: '', kindCount: 0, masteredCount: 0, monthlyCookCount: 0, recordCount: 0,
    settings: null as any, reminderOptions: [1, 2, 3, 5, 7], reminderIndex: 2,
    storageOptions: [{ id: 'room', name: '常温' }, { id: 'chilled', name: '冷藏' }, { id: 'frozen', name: '冷冻' }], storageIndex: 1,
  },
  onShow() { this.load(); },
  load() {
    this.setData({ loading: true, error: '' });
    try {
      const profile = appService.profile();
      this.setData({ ...profile, reminderIndex: Math.max(0, this.data.reminderOptions.indexOf(profile.settings.freshnessReminderDays)), storageIndex: Math.max(0, this.data.storageOptions.findIndex((item: any) => item.id === profile.settings.defaultStorageMode)), loading: false });
    } catch (error) { this.setData({ loading: false, error: error instanceof Error ? error.message : '加载失败' }); }
  },
  saveSettings(reminderIndex: number, storageIndex: number) {
    appService.updateSettings({ freshnessReminderDays: this.data.reminderOptions[reminderIndex], defaultStorageMode: this.data.storageOptions[storageIndex].id as any });
    this.setData({ reminderIndex, storageIndex }); wx.showToast({ title: '设置已保存', icon: 'success' });
  },
  onReminderChange(event: any) { this.saveSettings(Number(event.detail.value), this.data.storageIndex); },
  onStorageChange(event: any) { this.saveSettings(this.data.reminderIndex, Number(event.detail.value)); },
  exportData() {
    wx.setClipboardData({ data: appService.exportJson(), success: () => wx.showToast({ title: 'JSON 已复制', icon: 'success' }), fail: () => wx.showToast({ title: '导出失败', icon: 'none' }) });
  },
  resetData() {
    wx.showModal({ title: '清空全部本地数据？', content: '购入批次、做菜记录、食谱进度和购物清单都会被清除；食材与食谱基础库会保留。', confirmText: '确认清空', confirmColor: '#D96B62', success: (result: any) => { if (result.confirm) { appService.reset(); this.load(); wx.showToast({ title: '已清空', icon: 'success' }); } } });
  },
  openShopping() { wx.navigateTo({ url: '/pages/shopping-list/index' }); },
});
