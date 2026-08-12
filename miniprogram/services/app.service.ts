import type {
  AppSettings,
  FreshnessState,
  Ingredient,
  PantryBatch,
  Recipe,
  RecipeProgress,
  RecipeStatus,
  ShoppingItem,
  StorageMode,
} from '../domain/models';
import {
  aggregateInventory,
  calculateFreshness,
  calculateRecipeAvailability,
  completeCooking,
  parseDateOnly,
  previewCooking,
  refreshRecipeProgress,
  shelfLifeFor,
  startOfLocalDay,
  toDateOnly,
  unlockRecipe,
} from '../domain/rules';
import { createDevPantry } from '../data/dev-seed';
import { appConfig } from '../data/app-config';
import { seedIngredients } from '../data/ingredients';
import { seedRecipes } from '../data/recipes';
import type { AppRepository, AppSnapshot } from '../repositories/types';
import { LocalAppRepository } from '../repositories/local/local-app.repository';

const CURRENT_DATA_VERSION = 2;

export const freshnessText: Record<FreshnessState, string> = {
  fresh: '新鲜', good: '正常', useSoon: '尽快使用', overdue: '超过建议期',
};
export const statusText: Record<RecipeStatus, string> = {
  locked: '未解锁', unlockable: '可解锁', mastered: '已掌握',
};
export const storageText: Record<StorageMode, string> = { room: '常温', chilled: '冷藏', frozen: '冷冻' };
export const categoryText: Record<string, string> = {
  vegetable: '蔬菜', meat: '肉类', eggDairy: '蛋奶', seafood: '水产', staple: '主食', condiment: '调味', fruit: '水果', other: '冷冻/其他',
};
export const unitText: Record<string, string> = {
  g: '克', kg: '千克', ml: '毫升', L: '升', piece: '枚', pack: '包', bowl: '碗', tbsp: '汤匙', tsp: '茶匙',
};

export interface PurchaseInput {
  ingredientId: string;
  quantity: number;
  unit: string;
  purchasedAt: string;
  storageMode: StorageMode;
  shelfLifeDaysOverride?: number;
  note?: string;
  shoppingItemId?: string;
}

function id(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function ingredientById(snapshot: AppSnapshot, ingredientId: string): Ingredient {
  const ingredient = snapshot.ingredients.find((item) => item.id === ingredientId);
  if (!ingredient) throw new Error('没有找到这个食材');
  return ingredient;
}

function recipeById(snapshot: AppSnapshot, recipeId: string): Recipe {
  const recipe = snapshot.recipes.find((item) => item.id === recipeId);
  if (!recipe) throw new Error('没有找到这个食谱');
  return recipe;
}

export class AppService {
  private readonly repository: AppRepository;

  constructor(repository: AppRepository) { this.repository = repository; }

  bootstrap(now = Date.now()): void {
    if (this.repository.isInitialized()) return;
    const batches = appConfig.devSeed ? createDevPantry(now) : [];
    const progress: RecipeProgress[] = seedRecipes.map((recipe) => ({
      recipeId: recipe.id,
      status: recipe.unlockRule.type === 'starter' ? 'unlockable' : 'locked',
      cookCount: 0,
    }));
    this.repository.initialize({
      ingredients: seedIngredients,
      recipes: seedRecipes,
      batches,
      progress,
      cookingRecords: [],
      shoppingList: [],
      settings: { freshnessReminderDays: 3, defaultStorageMode: 'chilled' },
      meta: {
        version: CURRENT_DATA_VERSION,
        initializedAt: now,
        purchasedIngredientIds: Array.from(new Set(batches.map((batch) => batch.ingredientId))),
      },
    });
  }

  snapshot(): AppSnapshot {
    const snapshot = this.repository.read();
    const ingredients = mergeCatalog(seedIngredients, snapshot.ingredients ?? []);
    const recipes = mergeCatalog(seedRecipes, snapshot.recipes ?? []);
    const purchasedIngredientIds = Array.from(new Set([
      ...(snapshot.meta?.purchasedIngredientIds ?? []),
      ...(snapshot.batches ?? []).map((batch) => batch.ingredientId),
    ]));
    const meta = {
      version: CURRENT_DATA_VERSION,
      initializedAt: snapshot.meta?.initializedAt ?? Date.now(),
      purchasedIngredientIds,
    };
    const settings = snapshot.settings ?? { freshnessReminderDays: 3, defaultStorageMode: 'chilled' as const };
    const progress = refreshRecipeProgress(recipes, snapshot.progress ?? [], purchasedIngredientIds);
    if (JSON.stringify(ingredients) !== JSON.stringify(snapshot.ingredients)) this.repository.saveIngredients(ingredients);
    if (JSON.stringify(recipes) !== JSON.stringify(snapshot.recipes)) this.repository.saveRecipes(recipes);
    if (JSON.stringify(progress) !== JSON.stringify(snapshot.progress)) this.repository.saveProgress(progress);
    if (JSON.stringify(meta) !== JSON.stringify(snapshot.meta)) this.repository.saveMeta(meta);
    if (!snapshot.settings) this.repository.saveSettings(settings);
    return {
      ...snapshot,
      ingredients,
      recipes,
      batches: snapshot.batches ?? [],
      progress,
      cookingRecords: snapshot.cookingRecords ?? [],
      shoppingList: snapshot.shoppingList ?? [],
      settings,
      meta,
    };
  }

  home(now = Date.now()) {
    const snapshot = this.snapshot();
    const summaries = aggregateInventory(snapshot.batches, snapshot.ingredients, now);
    const priority = summaries
      .filter((item) => item.earliestFreshness.remainingDays <= snapshot.settings.freshnessReminderDays)
      .sort((a, b) => a.earliestFreshness.expiresAt - b.earliestFreshness.expiresAt)
      .map((item) => this.summaryView(snapshot, item));
    const recipes = this.recipeCards(snapshot).sort((a, b) => a.rank - b.rank || b.matchedCount - a.matchedCount).slice(0, 4);
    return {
      greeting: greetingText(new Date(now).getHours()),
      kindCount: summaries.length,
      priorityCount: priority.length,
      priority,
      recipes,
    };
  }

  pantry(filter = 'all', category = 'all', now = Date.now()) {
    const snapshot = this.snapshot();
    let summaries = aggregateInventory(snapshot.batches, snapshot.ingredients, now).map((item) => this.summaryView(snapshot, item));
    if (filter === 'urgent') summaries = summaries.filter((item) => ['useSoon', 'overdue'].includes(item.freshnessState));
    if (['room', 'chilled', 'frozen'].includes(filter)) summaries = summaries.filter((item) => item.storageModeValues.includes(filter as StorageMode));
    if (category !== 'all') summaries = summaries.filter((item) => item.category === category);
    return summaries.sort((a, b) => a.expiresAt - b.expiresAt);
  }

  pantryDetail(ingredientId: string, now = Date.now()) {
    const snapshot = this.snapshot();
    const ingredient = ingredientById(snapshot, ingredientId);
    const batches = snapshot.batches
      .filter((batch) => batch.ingredientId === ingredientId && batch.status === 'active' && batch.quantity > 0)
      .map((batch) => {
        const freshness = calculateFreshness(batch, ingredient, now);
        return {
          ...batch,
          freshnessState: freshness.state,
          freshnessLabel: freshnessText[freshness.state],
          ageDays: freshness.ageDays,
          shelfLifeDays: freshness.shelfLifeDays,
          remainingText: freshness.remainingDays >= 0 ? `建议剩余 ${freshness.remainingDays} 天` : `已超过建议期 ${Math.abs(freshness.remainingDays)} 天`,
          progress: Math.min(100, Math.round(freshness.ratio * 100)),
          expiresAt: freshness.expiresAt,
          storageLabel: storageText[batch.storageMode],
        };
      })
      .sort((a, b) => a.expiresAt - b.expiresAt || parseDateOnly(a.purchasedAt) - parseDateOnly(b.purchasedAt) || a.createdAt - b.createdAt);
    return { ingredient, batches, total: batches.reduce((sum, batch) => sum + batch.quantity, 0), unitLabel: unitText[ingredient.defaultUnit] };
  }

  purchaseOptions() {
    const snapshot = this.snapshot();
    const recentIds = Array.from(new Set(snapshot.batches.slice().sort((a, b) => b.createdAt - a.createdAt).map((item) => item.ingredientId))).slice(0, 6);
    return {
      ingredients: snapshot.ingredients.map((item) => ({ ...item, unitLabel: unitText[item.defaultUnit] })),
      recent: recentIds.map((ingredientId) => ingredientById(snapshot, ingredientId)),
      settings: snapshot.settings,
      today: toDateOnly(Date.now()),
    };
  }

  purchase(input: PurchaseInput): void {
    if (!input.ingredientId || !Number.isFinite(input.quantity) || input.quantity <= 0) throw new Error('请输入有效的购入数量');
    const snapshot = this.snapshot();
    const ingredient = ingredientById(snapshot, input.ingredientId);
    if (input.unit !== ingredient.defaultUnit) throw new Error('购入单位与食材默认单位不一致');
    if (parseDateOnly(input.purchasedAt) > startOfLocalDay(Date.now())) throw new Error('购入日期不能晚于今天');
    if (input.shelfLifeDaysOverride !== undefined && (!Number.isFinite(input.shelfLifeDaysOverride) || input.shelfLifeDaysOverride <= 0)) {
      throw new Error('自定义保鲜天数必须大于 0');
    }
    shelfLifeFor({ storageMode: input.storageMode, shelfLifeDaysOverride: input.shelfLifeDaysOverride } as PantryBatch, ingredient);
    const now = Date.now();
    const batch: PantryBatch = {
      id: id('batch'), ingredientId: input.ingredientId, quantity: input.quantity, unit: input.unit,
      purchasedAt: input.purchasedAt, storageMode: input.storageMode, status: 'active', createdAt: now, updatedAt: now,
      ...(input.shelfLifeDaysOverride ? { shelfLifeDaysOverride: input.shelfLifeDaysOverride } : {}),
      ...(input.note ? { note: input.note } : {}),
    };
    const nextBatches = [...snapshot.batches, batch];
    const purchasedIngredientIds = Array.from(new Set([...snapshot.meta.purchasedIngredientIds, input.ingredientId]));
    const nextMeta = { ...snapshot.meta, purchasedIngredientIds };
    const nextShoppingList = input.shoppingItemId
      ? snapshot.shoppingList.map((item) => item.id === input.shoppingItemId ? { ...item, checked: true } : item)
      : snapshot.shoppingList;
    const nextProgress = refreshRecipeProgress(snapshot.recipes, snapshot.progress, purchasedIngredientIds);
    try {
      this.repository.saveBatches(nextBatches);
      this.repository.saveMeta(nextMeta);
      this.repository.saveShoppingList(nextShoppingList);
      this.repository.saveProgress(nextProgress);
    } catch (error) {
      this.repository.saveBatches(snapshot.batches);
      this.repository.saveMeta(snapshot.meta);
      this.repository.saveShoppingList(snapshot.shoppingList);
      this.repository.saveProgress(snapshot.progress);
      throw error;
    }
  }

  discardBatch(batchId: string): void {
    const snapshot = this.snapshot();
    const now = Date.now();
    this.repository.saveBatches(snapshot.batches.map((batch) => batch.id === batchId ? { ...batch, status: 'discarded', updatedAt: now } : batch));
  }

  recipes(filter = 'all') {
    const cards = this.recipeCards(this.snapshot());
    return (filter === 'all' ? cards : cards.filter((item) => item.status === filter)).sort((a, b) => a.rank - b.rank || b.matchedCount - a.matchedCount);
  }

  recipeDetail(recipeId: string) {
    const snapshot = this.snapshot();
    const recipe = recipeById(snapshot, recipeId);
    const progress = snapshot.progress.find((item) => item.recipeId === recipeId)!;
    const availability = calculateRecipeAvailability(recipe, snapshot.batches);
    return {
      recipe, progress, statusLabel: statusText[progress.status], availability,
      availabilityText: `${availability.matchedCount}/${availability.requiredCount}`,
      canStartCooking: progress.status === 'mastered',
      startButtonText: progress.status !== 'mastered'
        ? (progress.status === 'unlockable' ? '请先解锁食谱' : '尚未满足解锁条件')
        : availability.canCook ? '开始做菜' : '查看缺料并准备',
      ingredients: recipe.ingredients.map((item) => {
        const ingredient = ingredientById(snapshot, item.ingredientId);
        const available = snapshot.batches.filter((batch) => batch.status === 'active' && batch.ingredientId === item.ingredientId).reduce((sum, batch) => sum + batch.quantity, 0);
        return { ...item, name: ingredient.name, icon: ingredient.icon, available, enough: available >= item.amount, unitLabel: unitText[item.unit] ?? item.unit };
      }),
      substitutions: (recipe.substitutions ?? []).map((item) => ({
        ...item,
        fromName: ingredientById(snapshot, item.fromIngredientId).name,
        toName: ingredientById(snapshot, item.toIngredientId).name,
      })),
    };
  }

  unlock(recipeId: string): void {
    const snapshot = this.snapshot();
    this.repository.saveProgress(unlockRecipe(snapshot.progress, recipeId, Date.now()));
  }

  cookingPreview(recipeId: string, servings?: number) {
    const snapshot = this.snapshot();
    const recipe = recipeById(snapshot, recipeId);
    assertRecipeMastered(snapshot, recipeId);
    const preview = previewCooking(recipe, servings ?? recipe.servings, snapshot.batches, snapshot.ingredients);
    const group = recipe.ingredients.map((requirement) => {
      const ingredient = ingredientById(snapshot, requirement.ingredientId);
      const allocations = preview.allocations.filter((item) => item.ingredientId === requirement.ingredientId);
      const used = allocations.reduce((sum, item) => sum + item.quantity, 0);
      const required = requirement.amount * (preview.servings / recipe.servings);
      return {
        ingredientId: ingredient.id, name: ingredient.name, icon: ingredient.icon, optional: Boolean(requirement.optional),
        required, used, unit: requirement.unit, unitLabel: unitText[requirement.unit] ?? requirement.unit,
        enough: requirement.optional || used >= required,
        batches: allocations.map((item) => ({ ...item, purchasedAt: snapshot.batches.find((batch) => batch.id === item.pantryBatchId)?.purchasedAt })),
      };
    });
    return { recipe, preview, group };
  }

  completeCook(recipeId: string, servings: number): void {
    const snapshot = this.snapshot();
    const recipe = recipeById(snapshot, recipeId);
    assertRecipeMastered(snapshot, recipeId);
    const commit = completeCooking(recipe, servings, snapshot.batches, snapshot.ingredients, snapshot.progress, Date.now(), id('cook'));
    const records = [...snapshot.cookingRecords, commit.record];
    const progress = refreshRecipeProgress(snapshot.recipes, commit.progress, snapshot.meta.purchasedIngredientIds);
    try {
      this.repository.saveBatches(commit.batches);
      this.repository.saveCookingRecords(records);
      this.repository.saveProgress(progress);
    } catch (error) {
      this.repository.saveBatches(snapshot.batches);
      this.repository.saveCookingRecords(snapshot.cookingRecords);
      this.repository.saveProgress(snapshot.progress);
      throw error;
    }
  }

  addRecipeMissing(recipeId: string): number {
    const snapshot = this.snapshot();
    const recipe = recipeById(snapshot, recipeId);
    const availability = calculateRecipeAvailability(recipe, snapshot.batches);
    let list = snapshot.shoppingList.slice();
    availability.missing.forEach((missing) => {
      const existing = list.find((item) => !item.checked && item.ingredientId === missing.ingredientId);
      if (existing) {
        list = list.map((item) => item.id === existing.id ? { ...item, suggestedQuantity: Math.max(item.suggestedQuantity, missing.missing), sourceRecipeId: recipeId } : item);
      } else {
        list.push({ id: id('shop'), ingredientId: missing.ingredientId, suggestedQuantity: missing.missing, unit: missing.unit, sourceRecipeId: recipeId, checked: false, createdAt: Date.now() });
      }
    });
    this.repository.saveShoppingList(list);
    return availability.missing.length;
  }

  shoppingList() {
    const snapshot = this.snapshot();
    return snapshot.shoppingList
      .map((item) => ({
        ...item,
        ingredient: ingredientById(snapshot, item.ingredientId),
        sourceRecipeName: item.sourceRecipeId ? recipeById(snapshot, item.sourceRecipeId).name : '手动添加',
        unitLabel: unitText[item.unit] ?? item.unit,
      }))
      .sort((a, b) => Number(a.checked) - Number(b.checked) || b.createdAt - a.createdAt);
  }

  addShoppingItem(ingredientId: string, quantity: number): void {
    if (!Number.isFinite(quantity) || quantity <= 0) throw new Error('请输入有效的建议购买量');
    const snapshot = this.snapshot();
    const ingredient = ingredientById(snapshot, ingredientId);
    const item: ShoppingItem = { id: id('shop'), ingredientId, suggestedQuantity: quantity, unit: ingredient.defaultUnit, checked: false, createdAt: Date.now() };
    this.repository.saveShoppingList([...snapshot.shoppingList, item]);
  }

  checkShoppingItem(itemId: string, checked: boolean): void {
    const snapshot = this.snapshot();
    this.repository.saveShoppingList(snapshot.shoppingList.map((item) => item.id === itemId ? { ...item, checked } : item));
  }

  removeShoppingItem(itemId: string): void {
    const snapshot = this.snapshot();
    this.repository.saveShoppingList(snapshot.shoppingList.filter((item) => item.id !== itemId));
  }

  profile(now = Date.now()) {
    const snapshot = this.snapshot();
    const date = new Date(now);
    const monthStart = new Date(date.getFullYear(), date.getMonth(), 1).getTime();
    return {
      kindCount: aggregateInventory(snapshot.batches, snapshot.ingredients, now).length,
      masteredCount: snapshot.progress.filter((item) => item.status === 'mastered').length,
      monthlyCookCount: snapshot.cookingRecords.filter((item) => item.cookedAt >= monthStart).length,
      settings: snapshot.settings,
      recordCount: snapshot.cookingRecords.length,
    };
  }

  updateSettings(settings: AppSettings): void { this.repository.saveSettings(settings); }
  exportJson(): string { return this.repository.exportJson(); }
  reset(): void { this.repository.clear(); this.bootstrap(); }

  private summaryView(snapshot: AppSnapshot, summary: ReturnType<typeof aggregateInventory>[number]) {
    const ingredient = ingredientById(snapshot, summary.ingredientId);
    return {
      ...summary, ingredient, name: ingredient.name, icon: ingredient.icon, category: ingredient.category,
      quantityText: `${formatQuantity(summary.quantity)}${unitText[summary.unit] ?? summary.unit}`,
      freshnessState: summary.earliestFreshness.state,
      freshnessLabel: freshnessText[summary.earliestFreshness.state],
      remainingDays: summary.earliestFreshness.remainingDays,
      urgencyText: urgencyText(summary.earliestFreshness.remainingDays),
      expiresAt: summary.earliestFreshness.expiresAt,
      storageModeValues: summary.storageModes,
      storageLabel: summary.storageModes.map((mode) => storageText[mode]).join(' / '),
    };
  }

  private recipeCards(snapshot: AppSnapshot) {
    return snapshot.recipes.map((recipe) => {
      const progress = snapshot.progress.find((item) => item.recipeId === recipe.id)!;
      const availability = calculateRecipeAvailability(recipe, snapshot.batches);
      const missingNames = availability.missing.map((item) => ingredientById(snapshot, item.ingredientId).name);
      return {
        id: recipe.id, name: recipe.name, description: recipe.description, durationMin: recipe.durationMin,
        difficulty: recipe.difficulty, difficultyText: '●'.repeat(recipe.difficulty), status: progress.status,
        statusLabel: statusText[progress.status], matchedCount: availability.matchedCount, requiredCount: availability.requiredCount,
        availabilityPercent: Math.round(availability.availability * 100), canCook: availability.canCook,
        missingCount: availability.missing.length, missingText: missingNames.length ? `缺 ${missingNames.join('、')}` : '食材齐全',
        actionText: availability.canCook
          ? progress.status === 'mastered' ? '可直接做' : progress.status === 'unlockable' ? '可解锁' : '待解锁'
          : `缺 ${availability.missing.length} 项`,
        rank: recipeRank(progress.status, availability.missing.length),
      };
    });
  }
}

function recipeRank(status: RecipeStatus, missingCount: number): number {
  if (status === 'mastered' && missingCount === 0) return 1;
  if (status === 'unlockable' && missingCount === 0) return 2;
  if (status === 'mastered' && missingCount === 1) return 3;
  return 4;
}

function greetingText(hour: number): string {
  if (hour < 6) return '夜深了，看看冰箱里还有什么';
  if (hour < 11) return '早上好，家里有什么心里有数';
  if (hour < 14) return '中午好，看看今天能做什么';
  if (hour < 18) return '下午好，先安排快到期的食材';
  return '晚上好，冰箱里的食材别忘了';
}

function urgencyText(remainingDays: number): string {
  if (remainingDays < 0) return '已超过建议期';
  if (remainingDays === 0) return '建议今天使用';
  if (remainingDays <= 2) return `${remainingDays} 天内优先`;
  return `建议 ${remainingDays} 天内使用`;
}

function formatQuantity(value: number): string { return Number.isInteger(value) ? String(value) : value.toFixed(1); }

function mergeCatalog<T extends { id: string }>(seed: T[], stored: T[]): T[] {
  const seedIds = new Set(seed.map((item) => item.id));
  return [...seed, ...stored.filter((item) => !seedIds.has(item.id))];
}

function assertRecipeMastered(snapshot: AppSnapshot, recipeId: string): void {
  if (snapshot.progress.find((item) => item.recipeId === recipeId)?.status !== 'mastered') {
    throw new Error('请先解锁并掌握这个食谱');
  }
}

export const appService = new AppService(new LocalAppRepository());
