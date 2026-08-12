import { appService } from '../../services/app.service';

Page({
  data: { id: '', loading: true, error: '', recipe: null as any, progress: null as any, ingredients: [] as any[], substitutions: [] as any[], availability: null as any, availabilityText: '', statusLabel: '', canStartCooking: false, startButtonText: '' },
  onLoad(query: Record<string, string>) { this.setData({ id: query.id || '' }); },
  onShow() { if (this.data.id) this.load(); },
  load() {
    this.setData({ loading: true, error: '' });
    try { this.setData({ ...appService.recipeDetail(this.data.id), loading: false }); }
    catch (error) { this.setData({ loading: false, error: error instanceof Error ? error.message : '加载失败' }); }
  },
  unlock() {
    try { appService.unlock(this.data.id); wx.showToast({ title: '已掌握', icon: 'success' }); this.load(); }
    catch (error) { wx.showToast({ title: error instanceof Error ? error.message : '解锁失败', icon: 'none' }); }
  },
  startCook() {
    if (!this.data.canStartCooking) return;
    wx.navigateTo({ url: `/pages/cook-confirm/index?id=${this.data.id}` });
  },
  addMissing() {
    const count = appService.addRecipeMissing(this.data.id);
    wx.showToast({ title: count ? `已加入 ${count} 项` : '食材已经齐全', icon: 'none' });
  },
});
