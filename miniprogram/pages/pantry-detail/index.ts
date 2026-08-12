import { appService } from '../../services/app.service';

Page({
  data: { id: '', loading: true, error: '', ingredient: null as any, batches: [] as any[], total: 0, unitLabel: '' },
  onLoad(query: Record<string, string>) { this.setData({ id: query.id || '' }); },
  onShow() { if (this.data.id) this.load(); },
  load() {
    this.setData({ loading: true, error: '' });
    try { this.setData({ ...appService.pantryDetail(this.data.id), loading: false }); }
    catch (error) { this.setData({ loading: false, error: error instanceof Error ? error.message : '加载失败' }); }
  },
  purchase() { wx.navigateTo({ url: `/pages/ingredient-purchase/index?ingredientId=${this.data.id}` }); },
  discard(event: any) {
    const batchId = event.currentTarget.dataset.id;
    wx.showModal({ title: '移出这个批次？', content: '将标记为已丢弃，不会再计入库存。', confirmText: '确认移出', confirmColor: '#D96B62', success: (result: any) => { if (result.confirm) { appService.discardBatch(batchId); this.load(); } } });
  },
});
