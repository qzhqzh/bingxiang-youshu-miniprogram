import { unifiedAppService as appService } from '../../services/unified-app.service';

Page({
  data: { loading: true, error: '', items: [] as any[], ingredients: [] as any[], ingredientIndex: 0, manualQuantity: '' },
  onShow() { this.load(); },
  load() {
    this.setData({ loading: true, error: '' });
    try {
      const options = appService.purchaseOptions();
      this.setData({ items: appService.shoppingList(), ingredients: options.ingredients, loading: false });
    } catch (error) { this.setData({ loading: false, error: error instanceof Error ? error.message : '加载失败' }); }
  },
  onIngredientChange(event: any) { this.setData({ ingredientIndex: Number(event.detail.value) }); },
  onQuantityInput(event: any) { this.setData({ manualQuantity: event.detail.value }); },
  addManual() {
    const ingredient = this.data.ingredients[this.data.ingredientIndex];
    const quantity = Number(this.data.manualQuantity);
    if (!ingredient || !Number.isFinite(quantity) || quantity <= 0) { wx.showToast({ title: '请输入有效数量', icon: 'none' }); return; }
    appService.addShoppingItem(ingredient.id, quantity); this.setData({ manualQuantity: '' }); this.load();
  },
  toggle(event: any) {
    const itemId = event.currentTarget.dataset.id;
    const checked = Boolean(event.currentTarget.dataset.checked);
    if (checked) { appService.checkShoppingItem(itemId, false); this.load(); return; }
    const item = this.data.items.find((entry: any) => entry.id === itemId);
    if (!item) return;
    wx.showModal({
      title: '已经买到了？',
      content: '可以直接把这项转成真实库存批次，也可以只标记为已购买。',
      confirmText: '转入仓库',
      cancelText: '仅勾选',
      confirmColor: '#24564A',
      success: (result: any) => {
        if (result.confirm) this.openPurchase(item);
        else if (result.cancel) { appService.checkShoppingItem(itemId, true); this.load(); }
      },
    });
  },
  purchase(event: any) {
    const item = this.data.items.find((entry: any) => entry.id === event.currentTarget.dataset.id);
    if (!item) return;
    this.openPurchase(item);
  },
  openPurchase(item: any) { wx.navigateTo({ url: `/pages/ingredient-purchase/index?ingredientId=${item.ingredientId}&quantity=${item.suggestedQuantity}&shoppingItemId=${item.id}` }); },
  remove(event: any) { appService.removeShoppingItem(event.currentTarget.dataset.id); this.load(); },
  goPurchase() { wx.navigateTo({ url: '/pages/ingredient-purchase/index' }); },
});
