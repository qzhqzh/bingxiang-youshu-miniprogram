import { seedIngredients } from '../../data/ingredients';
import { seedRecipes } from '../../data/recipes';
import type {
  AppSettings,
  CookingRecord,
  PantryBatch,
  RecipeProgress,
  ShoppingItem,
} from '../../domain/models';
import type { AppRepository, AppSnapshot } from '../../repositories/types';
import type { HouseholdEnvelope, SyncEntityType } from '../../v2/models';

function values<T>(envelope: HouseholdEnvelope, type: SyncEntityType): T[] {
  return Object.values(envelope.entities[type] ?? {})
    .filter((entity) => !entity.deleted)
    .map((entity) => entity.value as T);
}

/** 把云同步信封转换为现有纯领域服务可读取的快照。 */
export function cloudEnvelopeToSnapshot(
  envelope: HouseholdEnvelope,
  userId: string,
  now = Date.now(),
): AppSnapshot {
  const batches = values<PantryBatch>(envelope, 'pantryBatch')
    .filter((item) => item.status === 'active' && item.quantity > 0);
  const movements = values<{ ingredientId?: string; type?: string; quantityDelta?: number }>(envelope, 'inventoryMovement');
  const purchasedIngredientIds = Array.from(new Set([
    ...batches.map((item) => item.ingredientId),
    ...movements
      .filter((item) => item.type === 'purchase' || (item.quantityDelta ?? 0) > 0)
      .map((item) => item.ingredientId)
      .filter((id): id is string => Boolean(id)),
  ]));
  const progressByRecipe = values<RecipeProgress & { userId?: string }>(envelope, 'recipeProgress')
    .filter((item) => !item.userId || item.userId === userId);
  const progress: RecipeProgress[] = seedRecipes.map((recipe) => {
    const current = progressByRecipe.find((item) => item.recipeId === recipe.id);
    return current ?? {
      recipeId: recipe.id,
      status: recipe.unlockRule.type === 'starter' ? 'unlockable' : 'locked',
      cookCount: 0,
    };
  });
  const preferenceEntity = envelope.entities.preferences?.[userId];
  const preference = preferenceEntity && !preferenceEntity.deleted
    ? preferenceEntity.value as Partial<AppSettings>
    : {};
  return {
    ingredients: seedIngredients,
    recipes: seedRecipes,
    batches,
    progress,
    cookingRecords: values<CookingRecord>(envelope, 'cookingRecord'),
    shoppingList: values<ShoppingItem>(envelope, 'shoppingItem'),
    settings: {
      freshnessReminderDays: preference.freshnessReminderDays ?? 3,
      defaultStorageMode: preference.defaultStorageMode ?? 'chilled',
      favoriteRecipeIds: preference.favoriteRecipeIds ?? [],
    },
    meta: { version: 2, initializedAt: envelope.updatedAt || now, purchasedIngredientIds },
  };
}

/** 页面读取云快照时使用的内存仓库；任何整理写入都不会触碰 wx storage。 */
export class SnapshotMemoryRepository implements AppRepository {
  constructor(private snapshot: AppSnapshot) {}
  isInitialized(): boolean { return true; }
  initialize(value: AppSnapshot): void { this.snapshot = value; }
  read(): AppSnapshot { return this.snapshot; }
  saveIngredients(value: AppSnapshot['ingredients']): void { this.snapshot = { ...this.snapshot, ingredients: value }; }
  saveBatches(value: AppSnapshot['batches']): void { this.snapshot = { ...this.snapshot, batches: value }; }
  saveRecipes(value: AppSnapshot['recipes']): void { this.snapshot = { ...this.snapshot, recipes: value }; }
  saveProgress(value: AppSnapshot['progress']): void { this.snapshot = { ...this.snapshot, progress: value }; }
  saveCookingRecords(value: AppSnapshot['cookingRecords']): void { this.snapshot = { ...this.snapshot, cookingRecords: value }; }
  saveShoppingList(value: AppSnapshot['shoppingList']): void { this.snapshot = { ...this.snapshot, shoppingList: value }; }
  saveSettings(value: AppSnapshot['settings']): void { this.snapshot = { ...this.snapshot, settings: value }; }
  saveMeta(value: AppSnapshot['meta']): void { this.snapshot = { ...this.snapshot, meta: value }; }
  replace(value: AppSnapshot): void { this.snapshot = value; }
  getImportBackup(): string | null { return null; }
  exportJson(): string { return JSON.stringify(this.snapshot); }
  clear(): void { throw new Error('云端数据不能通过本地清空操作删除'); }
}
