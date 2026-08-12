import type { AppSettings, CookingRecord, Ingredient, PantryBatch, Recipe, RecipeProgress, ShoppingItem } from '../../domain/models';
import type { AppRepository, AppSnapshot } from '../types';

const KEYS = {
  ingredients: 'pantry:v1:ingredients', batches: 'pantry:v1:batches', recipes: 'pantry:v1:recipes',
  progress: 'pantry:v1:recipeProgress', cookingRecords: 'pantry:v1:cookingRecords',
  shoppingList: 'pantry:v1:shoppingList', settings: 'pantry:v1:settings', meta: 'pantry:v1:meta',
} as const;

export class LocalAppRepository implements AppRepository {
  isInitialized(): boolean { return Boolean(wx.getStorageSync(KEYS.meta)); }

  initialize(snapshot: AppSnapshot): void {
    Object.entries(KEYS).forEach(([name, key]) => wx.setStorageSync(key, snapshot[name as keyof AppSnapshot]));
  }

  read(): AppSnapshot {
    return {
      ingredients: wx.getStorageSync(KEYS.ingredients) || [], batches: wx.getStorageSync(KEYS.batches) || [],
      recipes: wx.getStorageSync(KEYS.recipes) || [], progress: wx.getStorageSync(KEYS.progress) || [],
      cookingRecords: wx.getStorageSync(KEYS.cookingRecords) || [], shoppingList: wx.getStorageSync(KEYS.shoppingList) || [],
      settings: wx.getStorageSync(KEYS.settings), meta: wx.getStorageSync(KEYS.meta),
    };
  }

  saveIngredients(value: Ingredient[]): void { wx.setStorageSync(KEYS.ingredients, value); }
  saveBatches(value: PantryBatch[]): void { wx.setStorageSync(KEYS.batches, value); }
  saveRecipes(value: Recipe[]): void { wx.setStorageSync(KEYS.recipes, value); }
  saveProgress(value: RecipeProgress[]): void { wx.setStorageSync(KEYS.progress, value); }
  saveCookingRecords(value: CookingRecord[]): void { wx.setStorageSync(KEYS.cookingRecords, value); }
  saveShoppingList(value: ShoppingItem[]): void { wx.setStorageSync(KEYS.shoppingList, value); }
  saveSettings(value: AppSettings): void { wx.setStorageSync(KEYS.settings, value); }
  saveMeta(value: AppSnapshot['meta']): void { wx.setStorageSync(KEYS.meta, value); }
  exportJson(): string { return JSON.stringify(this.read(), null, 2); }
  clear(): void { Object.values(KEYS).forEach((key) => wx.removeStorageSync(key)); }
}
