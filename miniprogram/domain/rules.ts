import type {
  CookingCommit,
  CookingPreview,
  FreshnessResult,
  Ingredient,
  IngredientMissing,
  PantryBatch,
  PantrySummary,
  Recipe,
  RecipeAvailability,
  RecipeProgress,
  RecipeStatus,
} from './models';

const DAY_MS = 86_400_000;

export function parseDateOnly(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`无效日期：${value}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(timestamp);
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new Error(`无效日期：${value}`);
  }
  return timestamp;
}

export function toDateOnly(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp);
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
}

export function shelfLifeFor(batch: PantryBatch, ingredient: Ingredient): number {
  const days = batch.shelfLifeDaysOverride ?? ingredient.shelfLifeDays[batch.storageMode];
  if (!days || days <= 0) throw new Error(`${ingredient.name}没有${batch.storageMode}保存期配置`);
  return days;
}

export function calculateFreshness(
  batch: PantryBatch,
  ingredient: Ingredient,
  todayTimestamp: number,
): FreshnessResult {
  const purchased = parseDateOnly(batch.purchasedAt);
  const today = startOfLocalDay(todayTimestamp);
  const ageDays = Math.max(0, Math.floor((today - purchased) / DAY_MS));
  const shelfLifeDays = shelfLifeFor(batch, ingredient);
  const ratio = ageDays / shelfLifeDays;
  const state = ratio < 0.6 ? 'fresh' : ratio < 0.85 ? 'good' : ratio <= 1 ? 'useSoon' : 'overdue';
  return {
    state,
    ageDays,
    shelfLifeDays,
    remainingDays: shelfLifeDays - ageDays,
    ratio,
    expiresAt: purchased + shelfLifeDays * DAY_MS,
  };
}

export function aggregateInventory(
  batches: PantryBatch[],
  ingredients: Ingredient[],
  todayTimestamp: number,
): PantrySummary[] {
  const ingredientMap = new Map(ingredients.map((item) => [item.id, item]));
  const groups = new Map<string, PantryBatch[]>();
  batches.filter((batch) => batch.status === 'active' && batch.quantity > 0).forEach((batch) => {
    groups.set(batch.ingredientId, [...(groups.get(batch.ingredientId) ?? []), batch]);
  });
  return Array.from(groups.entries()).map(([ingredientId, active]) => {
    const ingredient = ingredientMap.get(ingredientId);
    if (!ingredient) throw new Error(`未知食材：${ingredientId}`);
    const withFreshness = active.map((batch) => ({ batch, freshness: calculateFreshness(batch, ingredient, todayTimestamp) }));
    withFreshness.sort((a, b) => a.freshness.expiresAt - b.freshness.expiresAt || a.batch.createdAt - b.batch.createdAt);
    return {
      ingredientId,
      quantity: active.reduce((sum, batch) => sum + batch.quantity, 0),
      unit: ingredient.defaultUnit,
      batchCount: active.length,
      storageModes: Array.from(new Set(active.map((batch) => batch.storageMode))),
      earliestFreshness: withFreshness[0].freshness,
    };
  });
}

export function inventoryTotals(batches: PantryBatch[]): Map<string, number> {
  const totals = new Map<string, number>();
  batches.filter((batch) => batch.status === 'active' && batch.quantity > 0).forEach((batch) => {
    totals.set(batch.ingredientId, (totals.get(batch.ingredientId) ?? 0) + batch.quantity);
  });
  return totals;
}

function shortage(ingredientId: string, required: number, available: number, unit: string): IngredientMissing {
  return { ingredientId, required, available, missing: Math.max(0, required - available), unit };
}

export function calculateRecipeAvailability(
  recipe: Recipe,
  batches: PantryBatch[],
  servings = recipe.servings,
): RecipeAvailability {
  const totals = inventoryTotals(batches);
  const factor = servings / recipe.servings;
  const requiredIngredients = recipe.ingredients.filter((item) => !item.optional);
  const optionalIngredients = recipe.ingredients.filter((item) => item.optional);
  const missing = requiredIngredients
    .map((item) => shortage(item.ingredientId, item.amount * factor, totals.get(item.ingredientId) ?? 0, item.unit))
    .filter((item) => item.missing > 0);
  const optionalMissing = optionalIngredients
    .map((item) => shortage(item.ingredientId, item.amount * factor, totals.get(item.ingredientId) ?? 0, item.unit))
    .filter((item) => item.missing > 0);
  const requiredCount = requiredIngredients.length;
  const matchedCount = requiredCount - missing.length;
  return {
    requiredCount,
    matchedCount,
    availability: requiredCount === 0 ? 1 : matchedCount / requiredCount,
    missing,
    optionalMissing,
    canCook: missing.length === 0,
  };
}

export function deriveRecipeStatus(
  recipe: Recipe,
  existing: RecipeProgress | undefined,
  allProgress: RecipeProgress[],
  purchasedIngredientIds: string[],
): RecipeStatus {
  if (existing?.status === 'mastered') return 'mastered';
  if (recipe.unlockRule.type === 'starter') return 'unlockable';
  if (recipe.unlockRule.type === 'inventory') {
    return recipe.unlockRule.ingredientIds.every((id) => purchasedIngredientIds.includes(id)) ? 'unlockable' : 'locked';
  }
  return recipe.unlockRule.recipeIds.every(
    (id) => allProgress.find((progress) => progress.recipeId === id)?.status === 'mastered',
  )
    ? 'unlockable'
    : 'locked';
}

export function refreshRecipeProgress(
  recipes: Recipe[],
  progress: RecipeProgress[],
  purchasedIngredientIds: string[],
): RecipeProgress[] {
  const base = recipes.map((recipe) => {
    const existing = progress.find((item) => item.recipeId === recipe.id);
    return existing ?? { recipeId: recipe.id, status: 'locked' as const, cookCount: 0 };
  });
  return recipes.map((recipe) => {
    const existing = base.find((item) => item.recipeId === recipe.id)!;
    return { ...existing, status: deriveRecipeStatus(recipe, existing, base, purchasedIngredientIds) };
  });
}

export function unlockRecipe(progress: RecipeProgress[], recipeId: string, now: number): RecipeProgress[] {
  const target = progress.find((item) => item.recipeId === recipeId);
  if (!target || target.status !== 'unlockable') throw new Error('当前食谱尚不可解锁');
  return progress.map((item) =>
    item.recipeId === recipeId ? { ...item, status: 'mastered', unlockedAt: now } : item,
  );
}

function sortedFefoBatches(
  ingredientId: string,
  batches: PantryBatch[],
  ingredients: Ingredient[],
): PantryBatch[] {
  const ingredient = ingredients.find((item) => item.id === ingredientId);
  if (!ingredient) throw new Error(`未知食材：${ingredientId}`);
  return batches
    .filter((batch) => batch.ingredientId === ingredientId && batch.status === 'active' && batch.quantity > 0)
    .slice()
    .sort((a, b) => {
      const expiryA = parseDateOnly(a.purchasedAt) + shelfLifeFor(a, ingredient) * DAY_MS;
      const expiryB = parseDateOnly(b.purchasedAt) + shelfLifeFor(b, ingredient) * DAY_MS;
      return expiryA - expiryB || parseDateOnly(a.purchasedAt) - parseDateOnly(b.purchasedAt) || a.createdAt - b.createdAt;
    });
}

export function previewCooking(
  recipe: Recipe,
  servings: number,
  batches: PantryBatch[],
  ingredients: Ingredient[],
): CookingPreview {
  const factor = servings / recipe.servings;
  const allocations: CookingPreview['allocations'] = [];
  const missing: IngredientMissing[] = [];
  const optionalMissing: IngredientMissing[] = [];
  recipe.ingredients.forEach((requirement) => {
    const needed = requirement.amount * factor;
    let remaining = needed;
    let available = 0;
    sortedFefoBatches(requirement.ingredientId, batches, ingredients).forEach((batch) => {
      if (remaining <= 0) return;
      const used = Math.min(batch.quantity, remaining);
      available += used;
      remaining -= used;
      allocations.push({
        pantryBatchId: batch.id,
        ingredientId: requirement.ingredientId,
        quantity: used,
        unit: requirement.unit,
      });
    });
    if (remaining > 0) {
      const item = shortage(requirement.ingredientId, needed, available, requirement.unit);
      (requirement.optional ? optionalMissing : missing).push(item);
    }
  });
  return { recipeId: recipe.id, servings, allocations, missing, optionalMissing, canComplete: missing.length === 0 };
}

export function completeCooking(
  recipe: Recipe,
  servings: number,
  batches: PantryBatch[],
  ingredients: Ingredient[],
  progress: RecipeProgress[],
  now: number,
  recordId: string,
): CookingCommit {
  const preview = previewCooking(recipe, servings, batches, ingredients);
  if (!preview.canComplete) throw new Error('必选食材不足，无法完成烹饪');
  const useByBatch = new Map<string, number>();
  preview.allocations.forEach((item) => useByBatch.set(item.pantryBatchId, (useByBatch.get(item.pantryBatchId) ?? 0) + item.quantity));
  const nextBatches = batches.map((batch) => {
    const used = useByBatch.get(batch.id) ?? 0;
    if (used === 0) return batch;
    const quantity = Math.max(0, batch.quantity - used);
    return { ...batch, quantity, status: quantity <= 0 ? ('consumed' as const) : batch.status, updatedAt: now };
  });
  const nextProgress = progress.map((item) =>
    item.recipeId === recipe.id
      ? { ...item, cookCount: item.cookCount + 1, lastCookedAt: now }
      : item,
  );
  return {
    batches: nextBatches,
    progress: nextProgress,
    record: {
      id: recordId,
      recipeId: recipe.id,
      cookedAt: now,
      servings,
      consumptions: preview.allocations,
    },
  };
}
