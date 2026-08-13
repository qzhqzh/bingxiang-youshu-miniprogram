import type { AppSettings } from '../domain/models';
import { calculateRecipeAvailability } from '../domain/rules';
import { AppService, appService as localAppService, type PurchaseInput } from './app.service';
import { cloudEnvelopeToSnapshot, SnapshotMemoryRepository } from './cloud/cloud-snapshot';
import { cloudSyncService } from './cloud/cloud-sync.service';

/**
 * 页面唯一业务入口：游客模式走 1.2 本地 Repository，云模式走 2.0 家庭信封与命令队列。
 * 页面始终不直接访问 wx storage。
 */
class UnifiedAppService {
  bootstrap(now = Date.now()): void { localAppService.bootstrap(now); }
  isCloudMode(): boolean { return cloudSyncService.authState().mode === 'cloud'; }

  private readService(): AppService {
    const auth = cloudSyncService.authState();
    const envelope = cloudSyncService.activeEnvelope();
    if (auth.mode !== 'cloud' || !auth.user || !envelope) return localAppService;
    return new AppService(new SnapshotMemoryRepository(cloudEnvelopeToSnapshot(envelope, auth.user.id)));
  }

  snapshot() { return this.readService().snapshot(); }
  home(now = Date.now()) { return this.readService().home(now); }
  pantry(filter = 'all', category = 'all', now = Date.now()) { return this.readService().pantry(filter, category, now); }
  pantryDetail(ingredientId: string, now = Date.now()) { return this.readService().pantryDetail(ingredientId, now); }
  purchaseOptions() { return this.readService().purchaseOptions(); }
  quickQuantities(unit: string): number[] { return localAppService.quickQuantities(unit); }
  recipes(filter = 'all', keyword = '') { return this.readService().recipes(filter, keyword); }
  recipeDetail(recipeId: string) { return this.readService().recipeDetail(recipeId); }
  cookingPreview(recipeId: string, servings?: number) { return this.readService().cookingPreview(recipeId, servings); }
  shoppingList() { return this.readService().shoppingList(); }
  profile(now = Date.now()) { return { ...this.readService().profile(now), isCloudMode: this.isCloudMode() }; }

  purchase(input: PurchaseInput): void {
    if (this.isCloudMode()) cloudSyncService.commands.purchase(input);
    else localAppService.purchase(input);
  }
  discardBatch(batchId: string): void {
    if (this.isCloudMode()) cloudSyncService.commands.discardBatch(batchId);
    else localAppService.discardBatch(batchId);
  }
  toggleRecipeFavorite(recipeId: string): boolean {
    if (!this.isCloudMode()) return localAppService.toggleRecipeFavorite(recipeId);
    const snapshot = this.readService().snapshot();
    if (!snapshot.recipes.some((item) => item.id === recipeId)) throw new Error('没有找到这个食谱');
    const current = snapshot.settings.favoriteRecipeIds ?? [];
    const favorite = !current.includes(recipeId);
    cloudSyncService.commands.updatePreferences({
      ...snapshot.settings,
      favoriteRecipeIds: favorite ? [...current, recipeId] : current.filter((id) => id !== recipeId),
    });
    return favorite;
  }
  unlock(recipeId: string): void {
    if (this.isCloudMode()) cloudSyncService.commands.unlockRecipe(recipeId);
    else localAppService.unlock(recipeId);
  }
  completeCook(recipeId: string, servings: number): void {
    if (this.isCloudMode()) cloudSyncService.commands.completeCooking(recipeId, servings);
    else localAppService.completeCook(recipeId, servings);
  }
  addRecipeMissing(recipeId: string): number {
    if (!this.isCloudMode()) return localAppService.addRecipeMissing(recipeId);
    const snapshot = this.readService().snapshot();
    const recipe = snapshot.recipes.find((item) => item.id === recipeId);
    if (!recipe) throw new Error('没有找到这个食谱');
    const missing = calculateRecipeAvailability(recipe, snapshot.batches).missing;
    const existing = new Set(snapshot.shoppingList.filter((item) => !item.checked).map((item) => item.ingredientId));
    const additions = missing.filter((item) => !existing.has(item.ingredientId));
    additions.forEach((item) => cloudSyncService.commands.addShoppingItem(item.ingredientId, item.missing, recipeId));
    return additions.length;
  }
  addShoppingItem(ingredientId: string, quantity: number): void {
    if (this.isCloudMode()) cloudSyncService.commands.addShoppingItem(ingredientId, quantity);
    else localAppService.addShoppingItem(ingredientId, quantity);
  }
  checkShoppingItem(itemId: string, checked: boolean): void {
    if (this.isCloudMode()) cloudSyncService.commands.checkShoppingItem(itemId, checked);
    else localAppService.checkShoppingItem(itemId, checked);
  }
  removeShoppingItem(itemId: string): void {
    if (this.isCloudMode()) cloudSyncService.commands.removeShoppingItem(itemId);
    else localAppService.removeShoppingItem(itemId);
  }
  updateSettings(settings: AppSettings): void {
    if (this.isCloudMode()) cloudSyncService.commands.updatePreferences(settings);
    else localAppService.updateSettings(settings);
  }

  private requireGuest(): void {
    if (this.isCloudMode()) throw new Error('云端数据请在“家庭与云同步”中管理');
  }
  exportJson(): string { this.requireGuest(); return localAppService.exportJson(); }
  previewImport(json: string) { this.requireGuest(); return localAppService.previewImport(json); }
  importJson(json: string) { this.requireGuest(); return localAppService.importJson(json); }
  restoreImportBackup() { this.requireGuest(); return localAppService.restoreImportBackup(); }
  reset(): void { this.requireGuest(); localAppService.reset(); }
}

export const unifiedAppService = new UnifiedAppService();
