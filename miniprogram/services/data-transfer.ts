import type { AppSnapshot } from '../repositories/types';
import { parseDateOnly } from '../domain/rules';

export interface ImportSummary {
  batchCount: number;
  activeBatchCount: number;
  cookingRecordCount: number;
  shoppingItemCount: number;
  masteredRecipeCount: number;
}

export interface ValidatedImport {
  snapshot: AppSnapshot;
  summary: ImportSummary;
}

const storageModes = new Set(['room', 'chilled', 'frozen']);
const batchStatuses = new Set(['active', 'consumed', 'discarded']);
const recipeStatuses = new Set(['locked', 'unlockable', 'mastered']);

function assertValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`导入数据无效：${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function records(value: unknown, field: string): Record<string, unknown>[] {
  assertValue(Array.isArray(value), `${field} 必须是数组`);
  value.forEach((item) => assertValue(isRecord(item), `${field} 中包含无效项目`));
  return value as Record<string, unknown>[];
}

function requiredString(value: unknown, field: string): string {
  assertValue(typeof value === 'string' && value.trim().length > 0, `${field} 不能为空`);
  return value;
}

function finiteNumber(value: unknown, field: string, minimum = 0): number {
  assertValue(typeof value === 'number' && Number.isFinite(value) && value >= minimum, `${field} 不是有效数字`);
  return value;
}

function uniqueIds(items: Record<string, unknown>[], field: string): Set<string> {
  const ids = new Set<string>();
  items.forEach((item) => {
    const id = requiredString(item.id, `${field}.id`);
    assertValue(!ids.has(id), `${field} 存在重复 ID：${id}`);
    ids.add(id);
  });
  return ids;
}

export function validateImportJson(source: string): ValidatedImport {
  assertValue(typeof source === 'string' && source.trim().length > 0, '剪贴板中没有 JSON');
  let parsed: unknown;
  try { parsed = JSON.parse(source); }
  catch { throw new Error('导入数据无效：JSON 格式无法解析'); }
  assertValue(isRecord(parsed), '根节点必须是对象');

  const ingredients = records(parsed.ingredients, 'ingredients');
  const recipes = records(parsed.recipes, 'recipes');
  const batches = records(parsed.batches, 'batches');
  const progress = records(parsed.progress, 'progress');
  const cookingRecords = records(parsed.cookingRecords, 'cookingRecords');
  const shoppingList = records(parsed.shoppingList, 'shoppingList');
  assertValue(isRecord(parsed.settings), 'settings 必须是对象');
  assertValue(isRecord(parsed.meta), 'meta 必须是对象');

  const ingredientIds = uniqueIds(ingredients, 'ingredients');
  const recipeIds = uniqueIds(recipes, 'recipes');
  const batchIds = uniqueIds(batches, 'batches');
  uniqueIds(cookingRecords, 'cookingRecords');
  uniqueIds(shoppingList, 'shoppingList');
  assertValue(ingredients.length > 0 && recipes.length > 0, '食材与食谱基础库不能为空');

  ingredients.forEach((item) => {
    requiredString(item.name, 'ingredient.name');
    requiredString(item.category, 'ingredient.category');
    requiredString(item.defaultUnit, 'ingredient.defaultUnit');
    requiredString(item.icon, 'ingredient.icon');
    assertValue(isRecord(item.shelfLifeDays), 'ingredient.shelfLifeDays 必须是对象');
    Object.entries(item.shelfLifeDays).forEach(([mode, days]) => {
      assertValue(storageModes.has(mode), `未知保存方式：${mode}`);
      finiteNumber(days, 'ingredient.shelfLifeDays', 1);
    });
  });

  recipes.forEach((item) => {
    requiredString(item.name, 'recipe.name');
    const requirements = records(item.ingredients, 'recipe.ingredients');
    requirements.forEach((requirement) => {
      const ingredientId = requiredString(requirement.ingredientId, 'recipe.ingredientId');
      assertValue(ingredientIds.has(ingredientId), `食谱引用未知食材：${ingredientId}`);
      finiteNumber(requirement.amount, 'recipe.amount', 0.000001);
      requiredString(requirement.unit, 'recipe.unit');
    });
    assertValue(Array.isArray(item.steps) && Array.isArray(item.cautions) && Array.isArray(item.tags), '食谱步骤、提示或标签格式错误');
  });

  batches.forEach((item) => {
    const ingredientId = requiredString(item.ingredientId, 'batch.ingredientId');
    assertValue(ingredientIds.has(ingredientId), `批次引用未知食材：${ingredientId}`);
    finiteNumber(item.quantity, 'batch.quantity');
    requiredString(item.unit, 'batch.unit');
    const purchasedAt = requiredString(item.purchasedAt, 'batch.purchasedAt');
    parseDateOnly(purchasedAt);
    assertValue(storageModes.has(String(item.storageMode)), `批次保存方式无效：${String(item.storageMode)}`);
    assertValue(batchStatuses.has(String(item.status)), `批次状态无效：${String(item.status)}`);
    finiteNumber(item.createdAt, 'batch.createdAt');
    finiteNumber(item.updatedAt, 'batch.updatedAt');
  });

  progress.forEach((item) => {
    const recipeId = requiredString(item.recipeId, 'progress.recipeId');
    assertValue(recipeIds.has(recipeId), `进度引用未知食谱：${recipeId}`);
    assertValue(recipeStatuses.has(String(item.status)), `食谱状态无效：${String(item.status)}`);
    finiteNumber(item.cookCount, 'progress.cookCount');
  });

  cookingRecords.forEach((item) => {
    const recipeId = requiredString(item.recipeId, 'cookingRecord.recipeId');
    assertValue(recipeIds.has(recipeId), `做菜记录引用未知食谱：${recipeId}`);
    finiteNumber(item.cookedAt, 'cookingRecord.cookedAt');
    finiteNumber(item.servings, 'cookingRecord.servings', 0.000001);
    records(item.consumptions, 'cookingRecord.consumptions').forEach((consumption) => {
      const batchId = requiredString(consumption.pantryBatchId, 'consumption.pantryBatchId');
      assertValue(batchIds.has(batchId), `做菜记录引用未知批次：${batchId}`);
      const ingredientId = requiredString(consumption.ingredientId, 'consumption.ingredientId');
      assertValue(ingredientIds.has(ingredientId), `做菜记录引用未知食材：${ingredientId}`);
      finiteNumber(consumption.quantity, 'consumption.quantity', 0.000001);
    });
  });

  shoppingList.forEach((item) => {
    const ingredientId = requiredString(item.ingredientId, 'shoppingItem.ingredientId');
    assertValue(ingredientIds.has(ingredientId), `购物项引用未知食材：${ingredientId}`);
    finiteNumber(item.suggestedQuantity, 'shoppingItem.suggestedQuantity', 0.000001);
    assertValue(typeof item.checked === 'boolean', 'shoppingItem.checked 必须是布尔值');
  });

  const settings = parsed.settings;
  finiteNumber(settings.freshnessReminderDays, 'settings.freshnessReminderDays', 1);
  assertValue(storageModes.has(String(settings.defaultStorageMode)), '默认保存方式无效');
  const favoriteRecipeIds = settings.favoriteRecipeIds ?? [];
  assertValue(Array.isArray(favoriteRecipeIds), 'favoriteRecipeIds 必须是数组');
  favoriteRecipeIds.forEach((id) => assertValue(typeof id === 'string' && recipeIds.has(id), `收藏引用未知食谱：${String(id)}`));

  finiteNumber(parsed.meta.version, 'meta.version', 1);
  finiteNumber(parsed.meta.initializedAt, 'meta.initializedAt');
  assertValue(Array.isArray(parsed.meta.purchasedIngredientIds), 'purchasedIngredientIds 必须是数组');
  parsed.meta.purchasedIngredientIds.forEach((id) => assertValue(typeof id === 'string' && ingredientIds.has(id), `购入历史引用未知食材：${String(id)}`));

  const snapshot = {
    ...parsed,
    settings: { ...settings, favoriteRecipeIds: Array.from(new Set(favoriteRecipeIds)) },
  } as unknown as AppSnapshot;
  return {
    snapshot,
    summary: {
      batchCount: batches.length,
      activeBatchCount: batches.filter((item) => item.status === 'active' && Number(item.quantity) > 0).length,
      cookingRecordCount: cookingRecords.length,
      shoppingItemCount: shoppingList.length,
      masteredRecipeCount: progress.filter((item) => item.status === 'mastered').length,
    },
  };
}
