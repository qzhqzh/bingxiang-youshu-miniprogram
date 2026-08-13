import { unifiedAppService as appService } from '../../services/unified-app.service';

Page({
  data: {
    loading: true, error: '', kindCount: 0, masteredCount: 0, monthlyCookCount: 0, recordCount: 0,
    hasImportBackup: false, isCloudMode: false,
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
    const settings = { ...this.data.settings, freshnessReminderDays: this.data.reminderOptions[reminderIndex], defaultStorageMode: this.data.storageOptions[storageIndex].id as any };
    appService.updateSettings(settings);
    this.setData({ reminderIndex, storageIndex, settings }); wx.showToast({ title: '设置已保存', icon: 'success' });
  },
  onReminderChange(event: any) { this.saveSettings(Number(event.detail.value), this.data.storageIndex); },
  onStorageChange(event: any) { this.saveSettings(this.data.reminderIndex, Number(event.detail.value)); },
  exportData() {
    if (this.data.isCloudMode) { wx.showToast({ title: '请到家庭与云同步中导出', icon: 'none' }); return; }
    wx.setClipboardData({ data: appService.exportJson(), success: () => wx.showToast({ title: 'JSON 已复制', icon: 'success' }), fail: () => wx.showToast({ title: '导出失败', icon: 'none' }) });
  },
  importData() {
    if (this.data.isCloudMode) { wx.showToast({ title: '云端模式无需重复导入', icon: 'none' }); return; }
    wx.getClipboardData({
      success: (result: any) => {
        try {
          const summary = appService.previewImport(result.data);
          wx.showModal({
            title: '导入剪贴板数据？',
            content: `将替换当前本地数据：${summary.activeBatchCount} 个有效批次、${summary.cookingRecordCount} 条做菜记录、${summary.shoppingItemCount} 个购物项。导入前会自动保存一份本机备份。`,
            confirmText: '确认导入', confirmColor: '#24564A',
            success: (choice: any) => {
              if (!choice.confirm) return;
              try { appService.importJson(result.data); this.load(); wx.showToast({ title: '导入成功', icon: 'success' }); }
              catch (error) { wx.showModal({ title: '导入失败', content: error instanceof Error ? error.message : '无法导入这份数据', showCancel: false }); }
            },
          });
        } catch (error) { wx.showModal({ title: '无法识别 JSON', content: error instanceof Error ? error.message : '请先复制冰箱有数导出的 JSON', showCancel: false }); }
      },
      fail: () => wx.showToast({ title: '无法读取剪贴板', icon: 'none' }),
    });
  },
  restoreImportBackup() {
    wx.showModal({
      title: '恢复导入前的数据？', content: '当前数据会先成为新的回退备份，然后恢复上一次导入前的本地数据。', confirmText: '确认恢复', confirmColor: '#24564A',
      success: (result: any) => {
        if (!result.confirm) return;
        try { appService.restoreImportBackup(); this.load(); wx.showToast({ title: '已恢复', icon: 'success' }); }
        catch (error) { wx.showToast({ title: error instanceof Error ? error.message : '恢复失败', icon: 'none' }); }
      },
    });
  },
  resetData() {
    if (this.data.isCloudMode) { wx.showToast({ title: '云端数据不能在这里清空', icon: 'none' }); return; }
    wx.showModal({ title: '清空全部本地数据？', content: '购入批次、做菜记录、食谱进度和购物清单都会被清除；食材与食谱基础库会保留。', confirmText: '确认清空', confirmColor: '#D96B62', success: (result: any) => { if (result.confirm) { appService.reset(); this.load(); wx.showToast({ title: '已清空', icon: 'success' }); } } });
  },
  openShopping() { wx.navigateTo({ url: '/pages/shopping-list/index' }); },
  openCloudSync() { wx.navigateTo({ url: '/pages/cloud-sync/index' }); },
});
