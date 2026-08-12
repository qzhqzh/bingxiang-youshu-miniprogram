import { appService } from '../../services/app.service';

Page({
  data: { loading: true, error: '', filter: 'all', recipes: [] as any[], filters: [{ id: 'all', name: '全部' }, { id: 'mastered', name: '已掌握' }, { id: 'unlockable', name: '可解锁' }, { id: 'locked', name: '未解锁' }] },
  onShow() { this.load(); },
  load() {
    this.setData({ loading: true, error: '' });
    try { this.setData({ recipes: appService.recipes(this.data.filter), loading: false }); }
    catch (error) { this.setData({ loading: false, error: error instanceof Error ? error.message : '加载失败' }); }
  },
  setFilter(event: any) { this.setData({ filter: event.currentTarget.dataset.id }, () => this.load()); },
  open(event: any) { wx.navigateTo({ url: `/pages/recipe-detail/index?id=${event.currentTarget.dataset.id}` }); },
});
