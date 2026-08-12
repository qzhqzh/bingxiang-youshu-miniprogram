import type { CloudRepository, AppSnapshot } from '../types';
import type { AppSettings, CookingRecord, Ingredient, PantryBatch, Recipe, RecipeProgress, ShoppingItem } from '../../domain/models';

export class CloudAppRepository implements CloudRepository {
  private unavailable(): never { throw new Error('云端 Repository 将在第二阶段接入'); }
  isInitialized(): boolean { return this.unavailable(); }
  initialize(_snapshot: AppSnapshot): void { this.unavailable(); }
  read(): AppSnapshot { return this.unavailable(); }
  saveIngredients(_value: Ingredient[]): void { this.unavailable(); }
  saveBatches(_value: PantryBatch[]): void { this.unavailable(); }
  saveRecipes(_value: Recipe[]): void { this.unavailable(); }
  saveProgress(_value: RecipeProgress[]): void { this.unavailable(); }
  saveCookingRecords(_value: CookingRecord[]): void { this.unavailable(); }
  saveShoppingList(_value: ShoppingItem[]): void { this.unavailable(); }
  saveSettings(_value: AppSettings): void { this.unavailable(); }
  saveMeta(_value: AppSnapshot['meta']): void { this.unavailable(); }
  replace(_snapshot: AppSnapshot, _createBackup?: boolean): void { this.unavailable(); }
  getImportBackup(): string | null { return this.unavailable(); }
  exportJson(): string { return this.unavailable(); }
  clear(): void { this.unavailable(); }
}
