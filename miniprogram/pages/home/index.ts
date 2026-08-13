import { unifiedAppService as appService } from '../../services/unified-app.service';

Page({
  data: { loading: true, error: '', greeting: '', kindCount: 0, priorityCount: 0, priority: [] as any[], recipes: [] as any[] },
  onShow() { this.load(); },
  load() {
    this.setData({ loading: true, error: '' });
    try { this.setData({ ...appService.home(), loading: false }); }
    catch (error) { this.setData({ loading: false, error: error instanceof Error ? error.message : '加载失败' }); }
  },
  goPurchase() { wx.navigateTo({ url: '/pages/ingredient-purchase/index' }); },
  goShopping() { wx.navigateTo({ url: '/pages/shopping-list/index' }); },
  goPantry() { wx.switchTab({ url: '/pages/pantry/index' }); },
  goRecipes() { wx.switchTab({ url: '/pages/recipes/index' }); },
  openIngredient(event: any) { wx.navigateTo({ url: `/pages/pantry-detail/index?id=${event.currentTarget.dataset.id}` }); },
  openRecipe(event: any) { wx.navigateTo({ url: `/pages/recipe-detail/index?id=${event.currentTarget.dataset.id}` }); },
  onShareAppMessage() { return { title: '冰箱有数，吃饭不愁', path: '/pages/home/index' }; },
  onShareTimeline() { return { title: '家里有什么、今天吃什么，打开冰箱有数就知道' }; },
});
