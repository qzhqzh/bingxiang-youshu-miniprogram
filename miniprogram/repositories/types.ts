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
import type { PullPage, PushResult, SyncCommand } from '../v2/models';
import type { BootstrapResponse } from '../services/cloud/remote-sync.gateway';

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
  replace(snapshot: AppSnapshot, createBackup?: boolean): void;
  getImportBackup(): string | null;
  exportJson(): string;
  clear(): void;
}

// 网络天然异步，2.0 不再让 CloudRepository 伪装成同步的 AppRepository。
// 页面仍只依赖 Service；SyncCoordinator 通过这个边界访问远端 canonical 数据。
export interface CloudRepository {
  bootstrap(accessToken: string, householdId: string): Promise<BootstrapResponse>;
  push(accessToken: string, command: SyncCommand): Promise<PushResult>;
  pull(accessToken: string, householdId: string, cursor: number, limit?: number): Promise<PullPage>;
}
