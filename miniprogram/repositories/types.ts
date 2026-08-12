import type {
  AppMeta,
  AppSettings,
  CookingRecord,
  Ingredient,
  PantryBatch,
  Recipe,
  RecipeProgress,
  ShoppingItem,
} from '../domain/models';

export interface AppSnapshot {
  ingredients: Ingredient[];
  batches: PantryBatch[];
  recipes: Recipe[];
  progress: RecipeProgress[];
  cookingRecords: CookingRecord[];
  shoppingList: ShoppingItem[];
  settings: AppSettings;
  meta: AppMeta;
}

export interface AppRepository {
  isInitialized(): boolean;
  initialize(snapshot: AppSnapshot): void;
  read(): AppSnapshot;
  saveIngredients(value: Ingredient[]): void;
  saveBatches(value: PantryBatch[]): void;
  saveRecipes(value: Recipe[]): void;
  saveProgress(value: RecipeProgress[]): void;
  saveCookingRecords(value: CookingRecord[]): void;
  saveShoppingList(value: ShoppingItem[]): void;
  saveSettings(value: AppSettings): void;
  saveMeta(value: AppMeta): void;
  exportJson(): string;
  clear(): void;
}

// 第二阶段的云端实现需遵守同一契约；页面与领域层无需改动。
export interface CloudRepository extends AppRepository {}
