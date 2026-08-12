import { appService, unitText } from '../../services/app.service';

Page({
  data: {
    loading: true, error: '', ingredients: [] as any[], recent: [] as any[], ingredientIndex: 0,
    storageOptions: [{ id: 'room', name: '常温' }, { id: 'chilled', name: '冷藏' }, { id: 'frozen', name: '冷冻' }], storageIndex: 1,
    ingredientId: '', quantity: '', unit: '', unitLabel: '', purchasedAt: '', shelfLifeDaysOverride: '', note: '', shoppingItemId: '',
  },
  onLoad(query: Record<string, string>) {
    try {
      const options = appService.purchaseOptions();
      const requestedId = query.ingredientId || '';
      const ingredientIndex = Math.max(0, options.ingredients.findIndex((item) => item.id === requestedId));
      const selected = options.ingredients[ingredientIndex];
      const preferredStorage = selected.shelfLifeDays[options.settings.defaultStorageMode]
        ? options.settings.defaultStorageMode
        : Object.keys(selected.shelfLifeDays)[0];
      const storageIndex = Math.max(0, this.data.storageOptions.findIndex((item: any) => item.id === preferredStorage));
      this.setData({
        ...options, ingredientIndex, storageIndex, ingredientId: selected.id, unit: selected.defaultUnit,
        unitLabel: unitText[selected.defaultUnit] ?? selected.defaultUnit, purchasedAt: options.today,
        quantity: query.quantity || '', shoppingItemId: query.shoppingItemId || '', loading: false,
      });
    } catch (error) { this.setData({ loading: false, error: error instanceof Error ? error.message : '加载失败' }); }
  },
  chooseRecent(event: any) {
    const ingredientId = event.currentTarget.dataset.id;
    const ingredientIndex = this.data.ingredients.findIndex((item: any) => item.id === ingredientId);
    this.applyIngredient(ingredientIndex);
  },
  onIngredientChange(event: any) { this.applyIngredient(Number(event.detail.value)); },
  applyIngredient(ingredientIndex: number) {
    const selected = this.data.ingredients[ingredientIndex];
    const currentMode = this.data.storageOptions[this.data.storageIndex].id;
    const nextMode = selected.shelfLifeDays[currentMode] ? currentMode : Object.keys(selected.shelfLifeDays)[0];
    const storageIndex = Math.max(0, this.data.storageOptions.findIndex((item: any) => item.id === nextMode));
    this.setData({ ingredientIndex, storageIndex, ingredientId: selected.id, unit: selected.defaultUnit, unitLabel: unitText[selected.defaultUnit] ?? selected.defaultUnit });
  },
  onStorageChange(event: any) { this.setData({ storageIndex: Number(event.detail.value) }); },
  onDateChange(event: any) { this.setData({ purchasedAt: event.detail.value }); },
  onInput(event: any) { this.setData({ [event.currentTarget.dataset.field]: event.detail.value }); },
  submit() {
    try {
      const storageMode = this.data.storageOptions[this.data.storageIndex].id as any;
      appService.purchase({
        ingredientId: this.data.ingredientId, quantity: Number(this.data.quantity), unit: this.data.unit,
        purchasedAt: this.data.purchasedAt, storageMode,
        shelfLifeDaysOverride: this.data.shelfLifeDaysOverride ? Number(this.data.shelfLifeDaysOverride) : undefined,
        note: this.data.note.trim(), shoppingItemId: this.data.shoppingItemId || undefined,
      });
      wx.showToast({ title: '已记入冰箱', icon: 'success' });
      setTimeout(() => wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/pantry/index' }) }), 650);
    } catch (error) { wx.showToast({ title: error instanceof Error ? error.message : '保存失败', icon: 'none' }); }
  },
});
