import { appService } from '../../services/app.service';

Page({
  data: { id: '', loading: true, error: '', recipe: null as any, preview: null as any, group: [] as any[], servings: 1, completing: false },
  onLoad(query: Record<string, string>) {
    const id = query.id || '';
    this.setData({ id });
    if (id) {
      try { const detail = appService.recipeDetail(id); this.setData({ servings: detail.recipe.servings }); this.load(); }
      catch (error) { this.setData({ loading: false, error: error instanceof Error ? error.message : '加载失败' }); }
    }
  },
  load() {
    this.setData({ loading: true, error: '' });
    try { this.setData({ ...appService.cookingPreview(this.data.id, this.data.servings), loading: false }); }
    catch (error) { this.setData({ loading: false, error: error instanceof Error ? error.message : '加载失败' }); }
  },
  changeServings(event: any) {
    const delta = Number(event.currentTarget.dataset.delta);
    const servings = Math.max(1, this.data.servings + delta);
    this.setData({ servings }, () => this.load());
  },
  addMissing() {
    const count = appService.addRecipeMissing(this.data.id);
    wx.showToast({ title: count ? `已加入 ${count} 项` : '无需添加', icon: 'none' });
  },
  complete() {
    if (!this.data.preview?.canComplete || this.data.completing) return;
    wx.showModal({
      title: '确认完成烹饪？', content: '确认后将按预计到期日优先扣减库存，并生成做菜记录。', confirmText: '完成烹饪', confirmColor: '#24564A',
      success: (result: any) => {
        if (!result.confirm) return;
        this.setData({ completing: true });
        try {
          appService.completeCook(this.data.id, this.data.servings);
          wx.showToast({ title: '开饭啦', icon: 'success' });
          setTimeout(() => wx.switchTab({ url: '/pages/home/index' }), 700);
        } catch (error) { this.setData({ completing: false }); wx.showToast({ title: error instanceof Error ? error.message : '提交失败', icon: 'none' }); }
      },
    });
  },
});
