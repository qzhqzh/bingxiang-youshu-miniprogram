import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Ingredient, PantryBatch, Recipe, RecipeProgress } from '../miniprogram/domain/models';
import {
  aggregateInventory,
  calculateFreshness,
  calculateRecipeAvailability,
  completeCooking,
  deriveRecipeStatus,
  parseDateOnly,
  previewCooking,
  refreshRecipeProgress,
  unlockRecipe,
} from '../miniprogram/domain/rules';
import { seedIngredients } from '../miniprogram/data/ingredients';
import { seedRecipes } from '../miniprogram/data/recipes';

const DAY = 86_400_000;
const TODAY = Date.UTC(2026, 7, 12);

const ingredients: Ingredient[] = [
  { id: 'egg', name: '鸡蛋', category: 'eggDairy', defaultUnit: 'piece', icon: '', shelfLifeDays: { chilled: 20 } },
  { id: 'tomato', name: '番茄', category: 'vegetable', defaultUnit: 'g', icon: '', shelfLifeDays: { chilled: 10 } },
  { id: 'oil', name: '油', category: 'condiment', defaultUnit: 'ml', icon: '', shelfLifeDays: { room: 100 } },
];

function batch(overrides: Partial<PantryBatch> = {}): PantryBatch {
  return {
    id: 'batch', ingredientId: 'egg', quantity: 2, unit: 'piece', purchasedAt: '2026-08-01',
    storageMode: 'chilled', status: 'active', createdAt: 1, updatedAt: 1, ...overrides,
  };
}

function recipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    id: 'recipe', name: '测试食谱', description: '', difficulty: 1, durationMin: 10, servings: 1,
    ingredients: [{ ingredientId: 'egg', amount: 2, unit: 'piece' }], steps: [], cautions: [],
    unlockRule: { type: 'starter' }, tags: [], ...overrides,
  };
}

describe('1. freshness 四种边界状态', () => {
  it('在 0.60、0.85、1.00 和 >1 边界返回规格状态', () => {
    const stateAtAge = (age: number) => calculateFreshness(batch({ purchasedAt: new Date(TODAY - age * DAY).toISOString().slice(0, 10) }), ingredients[0], TODAY).state;
    assert.equal(stateAtAge(11), 'fresh');
    assert.equal(stateAtAge(12), 'good');
    assert.equal(stateAtAge(16), 'good');
    assert.equal(stateAtAge(17), 'useSoon');
    assert.equal(stateAtAge(20), 'useSoon');
    assert.equal(stateAtAge(21), 'overdue');
  });

  it('拒绝格式错误或不存在的日期', () => {
    assert.throws(() => parseDateOnly('2026-2-03'), /无效日期/);
    assert.throws(() => parseDateOnly('2026-02-30'), /无效日期/);
  });
});

describe('2. 同食材多批次聚合', () => {
  it('只聚合 active 且数量大于零的批次', () => {
    const result = aggregateInventory([
      batch({ id: 'a', quantity: 2 }), batch({ id: 'b', quantity: 3, purchasedAt: '2026-08-05' }),
      batch({ id: 'c', quantity: 9, status: 'consumed' }),
    ], ingredients, TODAY);
    assert.equal(result.length, 1);
    assert.equal(result[0].quantity, 5);
    assert.equal(result[0].batchCount, 2);
  });
});

describe('3. FEFO 跨两个批次扣减', () => {
  it('先用预计到期更早的批次，不足后继续下一个', () => {
    const stock = [batch({ id: 'older', quantity: 1, purchasedAt: '2026-07-30' }), batch({ id: 'newer', quantity: 4, purchasedAt: '2026-08-05', createdAt: 2 })];
    const preview = previewCooking(recipe({ ingredients: [{ ingredientId: 'egg', amount: 3, unit: 'piece' }] }), 1, stock, ingredients);
    assert.deepEqual(preview.allocations.map(({ pantryBatchId, quantity }) => ({ pantryBatchId, quantity })), [
      { pantryBatchId: 'older', quantity: 1 }, { pantryBatchId: 'newer', quantity: 2 },
    ]);
  });

  it('预计到期日相同时按购入时间、创建时间排序', () => {
    const customIngredients: Ingredient[] = [ingredients[0]];
    const stock = [
      batch({ id: 'created-later', quantity: 1, purchasedAt: '2026-08-01', shelfLifeDaysOverride: 20, createdAt: 20 }),
      batch({ id: 'created-earlier', quantity: 1, purchasedAt: '2026-08-01', shelfLifeDaysOverride: 20, createdAt: 10 }),
    ];
    const preview = previewCooking(recipe({ ingredients: [{ ingredientId: 'egg', amount: 1, unit: 'piece' }] }), 1, stock, customIngredients);
    assert.equal(preview.allocations[0].pantryBatchId, 'created-earlier');
  });
});

describe('4. 可选配料不足不影响 availability', () => {
  it('可选缺料单独返回且 canCook 为 true', () => {
    const target = recipe({ ingredients: [{ ingredientId: 'egg', amount: 2, unit: 'piece' }, { ingredientId: 'oil', amount: 5, unit: 'ml', optional: true }] });
    const result = calculateRecipeAvailability(target, [batch({ quantity: 2 })]);
    assert.equal(result.canCook, true);
    assert.equal(result.missing.length, 0);
    assert.equal(result.optionalMissing[0].ingredientId, 'oil');
    assert.equal(result.availability, 1);
  });
});

describe('5. 必选配料不足 missing list', () => {
  it('返回现有量、需求量和精确缺口', () => {
    const target = recipe({ ingredients: [{ ingredientId: 'egg', amount: 3, unit: 'piece' }, { ingredientId: 'tomato', amount: 300, unit: 'g' }] });
    const result = calculateRecipeAvailability(target, [batch({ quantity: 1 }), batch({ id: 'tomato', ingredientId: 'tomato', quantity: 100, unit: 'g' })]);
    assert.deepEqual(result.missing, [
      { ingredientId: 'egg', required: 3, available: 1, missing: 2, unit: 'piece' },
      { ingredientId: 'tomato', required: 300, available: 100, missing: 200, unit: 'g' },
    ]);
    assert.equal(result.availability, 0);
  });
});

describe('6. starter 食谱默认为 unlockable', () => {
  it('不会自动 mastered，主动解锁后才 mastered', () => {
    const progress: RecipeProgress = { recipeId: 'recipe', status: 'locked', cookCount: 0 };
    assert.equal(deriveRecipeStatus(recipe(), progress, [progress], []), 'unlockable');
    const refreshed = refreshRecipeProgress([recipe()], [progress], []);
    assert.equal(refreshed[0].status, 'unlockable');
    assert.equal(unlockRecipe(refreshed, 'recipe', TODAY)[0].status, 'mastered');
  });
});

describe('7. prerequisite 食谱状态变化', () => {
  it('前置未掌握时 locked，掌握后 unlockable', () => {
    const target = recipe({ id: 'advanced', unlockRule: { type: 'prerequisite', recipeIds: ['basic'] } });
    const current: RecipeProgress = { recipeId: 'advanced', status: 'locked', cookCount: 0 };
    assert.equal(deriveRecipeStatus(target, current, [{ recipeId: 'basic', status: 'unlockable', cookCount: 0 }, current], []), 'locked');
    assert.equal(deriveRecipeStatus(target, current, [{ recipeId: 'basic', status: 'mastered', cookCount: 0 }, current], []), 'unlockable');
  });

  it('inventory 规则使用曾经入库历史，不要求当前仍有库存', () => {
    const target = recipe({ unlockRule: { type: 'inventory', ingredientIds: ['egg', 'tomato'] } });
    const current: RecipeProgress = { recipeId: 'recipe', status: 'locked', cookCount: 0 };
    assert.equal(deriveRecipeStatus(target, current, [current], ['egg']), 'locked');
    assert.equal(deriveRecipeStatus(target, current, [current], ['egg', 'tomato']), 'unlockable');
  });
});

describe('8. 完成烹饪生成 CookingRecord', () => {
  it('原子结果包含批次扣减、consumed、记录和 cookCount', () => {
    const stock = [batch({ id: 'a', quantity: 1 }), batch({ id: 'b', quantity: 3, purchasedAt: '2026-08-05' })];
    const progress: RecipeProgress[] = [{ recipeId: 'recipe', status: 'mastered', cookCount: 2 }];
    const result = completeCooking(recipe({ ingredients: [{ ingredientId: 'egg', amount: 3, unit: 'piece' }] }), 1, stock, ingredients, progress, TODAY, 'record-1');
    assert.equal(result.batches.find((item) => item.id === 'a')?.status, 'consumed');
    assert.equal(result.batches.find((item) => item.id === 'b')?.quantity, 1);
    assert.deepEqual(result.record, {
      id: 'record-1', recipeId: 'recipe', cookedAt: TODAY, servings: 1,
      consumptions: [
        { pantryBatchId: 'a', ingredientId: 'egg', quantity: 1, unit: 'piece' },
        { pantryBatchId: 'b', ingredientId: 'egg', quantity: 2, unit: 'piece' },
      ],
    });
    assert.equal(result.progress[0].cookCount, 3);
    assert.equal(result.progress[0].lastCookedAt, TODAY);
  });

  it('必选食材不足时拒绝提交，不生成半成品结果', () => {
    assert.throws(() => completeCooking(recipe({ ingredients: [{ ingredientId: 'egg', amount: 5, unit: 'piece' }] }), 1, [batch({ quantity: 1 })], ingredients, [], TODAY, 'bad'), /不足/);
  });
});

describe('11. seed 食材与食谱完整性', () => {
  it('目录 ID 唯一，食谱引用均存在且包含三种解锁规则', () => {
    const ingredientIds = new Set(seedIngredients.map((item) => item.id));
    const recipeIds = new Set(seedRecipes.map((item) => item.id));
    assert.equal(seedIngredients.length, 30);
    assert.equal(ingredientIds.size, seedIngredients.length);
    assert.equal(seedRecipes.length, 16);
    assert.equal(recipeIds.size, seedRecipes.length);
    seedRecipes.forEach((item) => {
      item.ingredients.forEach((ingredient) => assert.ok(ingredientIds.has(ingredient.ingredientId), `${item.id} 引用了未知食材`));
      if (item.unlockRule.type === 'prerequisite') {
        item.unlockRule.recipeIds.forEach((recipeId) => assert.ok(recipeIds.has(recipeId), `${item.id} 引用了未知前置食谱`));
      }
    });
    assert.deepEqual(new Set(seedRecipes.map((item) => item.unlockRule.type)), new Set(['starter', 'inventory', 'prerequisite']));
  });
});
