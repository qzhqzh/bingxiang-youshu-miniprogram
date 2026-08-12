import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  AppSettings,
  CookingRecord,
  Ingredient,
  PantryBatch,
  Recipe,
  RecipeProgress,
  ShoppingItem,
} from '../miniprogram/domain/models';
import type { AppRepository, AppSnapshot } from '../miniprogram/repositories/types';
import { AppService } from '../miniprogram/services/app.service';

class MemoryRepository implements AppRepository {
  constructor(public value: AppSnapshot) {}
  isInitialized(): boolean { return true; }
  initialize(value: AppSnapshot): void { this.value = value; }
  read(): AppSnapshot { return this.value; }
  saveIngredients(value: Ingredient[]): void { this.value.ingredients = value; }
  saveBatches(value: PantryBatch[]): void { this.value.batches = value; }
  saveRecipes(value: Recipe[]): void { this.value.recipes = value; }
  saveProgress(value: RecipeProgress[]): void { this.value.progress = value; }
  saveCookingRecords(value: CookingRecord[]): void { this.value.cookingRecords = value; }
  saveShoppingList(value: ShoppingItem[]): void { this.value.shoppingList = value; }
  saveSettings(value: AppSettings): void { this.value.settings = value; }
  saveMeta(value: AppSnapshot['meta']): void { this.value.meta = value; }
  exportJson(): string { return JSON.stringify(this.value); }
  clear(): void {}
}

const now = Date.UTC(2026, 7, 12, 8);
const egg: Ingredient = {
  id: 'test_egg', name: '测试鸡蛋', category: 'eggDairy', defaultUnit: 'piece',
  icon: '/assets/png/ingredient-egg.png', shelfLifeDays: { chilled: 20 },
};
const tomato: Ingredient = {
  id: 'test_tomato', name: '测试番茄', category: 'vegetable', defaultUnit: 'g',
  icon: '/assets/png/ingredient-tomato.png', shelfLifeDays: { chilled: 8 },
};

function starterRecipe(id = 'test_recipe'): Recipe {
  return {
    id, name: '测试蒸蛋', description: '', difficulty: 1, durationMin: 10, servings: 1,
    ingredients: [{ ingredientId: egg.id, amount: 2, unit: 'piece' }], steps: [], cautions: [],
    unlockRule: { type: 'starter' }, tags: [],
  };
}

function snapshot(recipes: Recipe[], batches: PantryBatch[] = []): AppSnapshot {
  return {
    ingredients: [egg, tomato], recipes, batches,
    progress: recipes.map((recipe) => ({ recipeId: recipe.id, status: 'unlockable', cookCount: 0 })),
    cookingRecords: [], shoppingList: [],
    settings: { freshnessReminderDays: 3, defaultStorageMode: 'chilled' },
    meta: { version: 2, initializedAt: now, purchasedIngredientIds: batches.map((batch) => batch.ingredientId) },
  };
}

describe('9. Service 解锁 → 做菜 → 记录闭环', () => {
  it('未主动解锁时拒绝做菜，解锁后扣库存并写入记录', () => {
    const recipe = starterRecipe();
    const stock: PantryBatch[] = [{
      id: 'service_batch', ingredientId: egg.id, quantity: 3, unit: 'piece', purchasedAt: '2026-08-10',
      storageMode: 'chilled', status: 'active', createdAt: 1, updatedAt: 1,
    }];
    const repository = new MemoryRepository(snapshot([recipe], stock));
    const service = new AppService(repository);

    assert.throws(() => service.cookingPreview(recipe.id, 1), /先解锁/);
    service.unlock(recipe.id);
    assert.equal(service.cookingPreview(recipe.id, 1).preview.canComplete, true);
    service.completeCook(recipe.id, 1);

    const saved = service.snapshot();
    assert.equal(saved.batches.find((item) => item.id === 'service_batch')?.quantity, 1);
    assert.equal(saved.cookingRecords.length, 1);
    assert.equal(saved.cookingRecords[0].recipeId, recipe.id);
    assert.equal(saved.progress.find((item) => item.recipeId === recipe.id)?.cookCount, 1);
  });
});

describe('10. 购物清单 → 购入 → 仓库闭环', () => {
  it('食谱缺料加入清单，转购入后生成批次并勾选原项目', () => {
    const recipe: Recipe = {
      ...starterRecipe('test_tomato_recipe'),
      ingredients: [{ ingredientId: tomato.id, amount: 300, unit: 'g' }],
    };
    const repository = new MemoryRepository(snapshot([recipe]));
    const service = new AppService(repository);

    assert.equal(service.addRecipeMissing(recipe.id), 1);
    const shoppingItem = service.shoppingList()[0];
    assert.equal(shoppingItem.suggestedQuantity, 300);

    service.purchase({
      ingredientId: tomato.id,
      quantity: shoppingItem.suggestedQuantity,
      unit: 'g',
      purchasedAt: '2026-08-12',
      storageMode: 'chilled',
      shoppingItemId: shoppingItem.id,
    });

    const saved = service.snapshot();
    assert.equal(saved.batches.find((item) => item.ingredientId === tomato.id)?.quantity, 300);
    assert.equal(saved.shoppingList.find((item) => item.id === shoppingItem.id)?.checked, true);
    assert.ok(saved.meta.purchasedIngredientIds.includes(tomato.id));
  });
});
