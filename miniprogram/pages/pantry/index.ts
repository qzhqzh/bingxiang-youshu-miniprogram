import { unifiedAppService as appService } from '../../services/unified-app.service';

Page({
  data: {
    loading: true, error: '', items: [] as any[], filter: 'all', category: 'all',
    filters: [{ id: 'all', name: '全部' }, { id: 'urgent', name: '快过期' }, { id: 'chilled', name: '冷藏' }, { id: 'frozen', name: '冷冻' }, { id: 'room', name: '常温' }],
    categories: [{ id: 'all', name: '全部分类' }, { id: 'vegetable', name: '蔬菜' }, { id: 'meat', name: '肉类' }, { id: 'eggDairy', name: '蛋奶' }, { id: 'seafood', name: '水产' }, { id: 'staple', name: '主食' }, { id: 'condiment', name: '调味' }, { id: 'fruit', name: '水果' }, { id: 'other', name: '冷冻/其他' }],
  },
  onShow() { this.load(); },
  load() {
    this.setData({ loading: true, error: '' });
    try { this.setData({ items: appService.pantry(this.data.filter, this.data.category), loading: false }); }
    catch (error) { this.setData({ loading: false, error: error instanceof Error ? error.message : '加载失败' }); }
  },
  setFilter(event: any) { this.setData({ filter: event.currentTarget.dataset.id }, () => this.load()); },
  setCategory(event: any) { this.setData({ category: event.currentTarget.dataset.id }, () => this.load()); },
  open(event: any) { wx.navigateTo({ url: `/pages/pantry-detail/index?id=${event.currentTarget.dataset.id}` }); },
  useIngredient() { wx.switchTab({ url: '/pages/recipes/index' }); },
  purchase(event?: any) { const id = event?.currentTarget?.dataset?.id; wx.navigateTo({ url: `/pages/ingredient-purchase/index${id ? `?ingredientId=${id}` : ''}` }); },
});
