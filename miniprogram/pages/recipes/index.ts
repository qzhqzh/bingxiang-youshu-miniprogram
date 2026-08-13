import { unifiedAppService as appService } from '../../services/unified-app.service';

Page({
  data: {
    loading: true, error: '', filter: 'all', keyword: '', recipes: [] as any[],
    filters: [{ id: 'all', name: '全部' }, { id: 'ready', name: '库存齐全' }, { id: 'favorite', name: '我的收藏' }, { id: 'mastered', name: '已掌握' }, { id: 'unlockable', name: '可解锁' }, { id: 'locked', name: '未解锁' }],
  },
  onShow() { this.load(); },
  load() {
    this.setData({ loading: true, error: '' });
    try { this.setData({ recipes: appService.recipes(this.data.filter, this.data.keyword), loading: false }); }
    catch (error) { this.setData({ loading: false, error: error instanceof Error ? error.message : '加载失败' }); }
  },
  setFilter(event: any) { this.setData({ filter: event.currentTarget.dataset.id }, () => this.load()); },
  onSearch(event: any) { this.setData({ keyword: event.detail.value }, () => this.load()); },
  clearSearch() { this.setData({ keyword: '' }, () => this.load()); },
  toggleFavorite(event: any) {
    const favorite = appService.toggleRecipeFavorite(event.currentTarget.dataset.id);
    wx.showToast({ title: favorite ? '已收藏' : '已取消收藏', icon: 'none' });
    this.load();
  },
  open(event: any) { wx.navigateTo({ url: `/pages/recipe-detail/index?id=${event.currentTarget.dataset.id}` }); },
});
