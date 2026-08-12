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
  backup: string | null = null;
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
  replace(value: AppSnapshot, createBackup = true): void {
    if (createBackup) this.backup = JSON.stringify(this.value);
    this.value = value;
  }
  getImportBackup(): string | null { return this.backup; }
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

describe('12. JSON 导入、校验与回退', () => {
  it('导入前保存备份，导入后可以恢复原数据', () => {
    const repository = new MemoryRepository(snapshot([starterRecipe()]));
    const service = new AppService(repository);
    const imported = snapshot([starterRecipe()], [{
      id: 'imported_batch', ingredientId: egg.id, quantity: 6, unit: 'piece', purchasedAt: '2026-08-12',
      storageMode: 'chilled', status: 'active', createdAt: 2, updatedAt: 2,
    }]);

    const preview = service.previewImport(JSON.stringify(imported));
    assert.equal(preview.activeBatchCount, 1);
    service.importJson(JSON.stringify(imported));
    assert.equal(service.snapshot().batches[0].quantity, 6);
    assert.ok(repository.getImportBackup());

    service.restoreImportBackup();
    assert.equal(service.snapshot().batches.length, 0);
  });

  it('拒绝损坏 JSON 和未知食材引用，不覆盖当前数据', () => {
    const repository = new MemoryRepository(snapshot([starterRecipe()]));
    const service = new AppService(repository);
    assert.throws(() => service.importJson('{broken'), /JSON 格式/);
    const invalid = snapshot([starterRecipe()], [{
      id: 'bad_batch', ingredientId: 'missing', quantity: 1, unit: 'piece', purchasedAt: '2026-08-12',
      storageMode: 'chilled', status: 'active', createdAt: 1, updatedAt: 1,
    }]);
    assert.throws(() => service.importJson(JSON.stringify(invalid)), /未知食材/);
    assert.equal(repository.value.batches.length, 0);
  });
});

describe('13. 食谱搜索、库存筛选与收藏', () => {
  it('按菜名/食材搜索，收藏后可以独立筛选', () => {
    const eggRecipe = starterRecipe('egg_recipe');
    const tomatoRecipe: Recipe = {
      ...starterRecipe('tomato_recipe'), name: '番茄小菜', tags: ['酸甜'],
      ingredients: [{ ingredientId: tomato.id, amount: 100, unit: 'g' }],
    };
    const stock: PantryBatch[] = [{
      id: 'egg_stock', ingredientId: egg.id, quantity: 3, unit: 'piece', purchasedAt: '2026-08-12',
      storageMode: 'chilled', status: 'active', createdAt: 1, updatedAt: 1,
    }];
    const service = new AppService(new MemoryRepository(snapshot([eggRecipe, tomatoRecipe], stock)));

    assert.deepEqual(service.recipes('all', '番茄小菜').map((item) => item.id), ['tomato_recipe']);
    assert.deepEqual(service.recipes('all', '测试鸡蛋').map((item) => item.id), ['egg_recipe']);
    assert.deepEqual(service.recipes('ready').map((item) => item.id), ['egg_recipe']);
    assert.equal(service.toggleRecipeFavorite('tomato_recipe'), true);
    assert.deepEqual(service.recipes('favorite').map((item) => item.id), ['tomato_recipe']);
    assert.equal(service.toggleRecipeFavorite('tomato_recipe'), false);
    assert.equal(service.recipes('favorite').length, 0);
  });
});

describe('14. 快捷购入建议', () => {
  it('最近购入保留上次数量和保存方式，并提供常用数量', () => {
    const stock: PantryBatch[] = [{
      id: 'recent_batch', ingredientId: tomato.id, quantity: 500, unit: 'g', purchasedAt: '2026-08-12',
      storageMode: 'chilled', status: 'active', createdAt: 10, updatedAt: 10,
    }];
    const service = new AppService(new MemoryRepository(snapshot([starterRecipe()], stock)));
    const options = service.purchaseOptions();
    assert.equal(options.recent[0].id, tomato.id);
    assert.equal(options.recent[0].lastQuantity, 500);
    assert.equal(options.recent[0].lastStorageMode, 'chilled');
    assert.deepEqual(service.quickQuantities('g'), [100, 250, 500, 1000]);
    assert.deepEqual(service.quickQuantities('piece'), [1, 2, 6, 10, 12]);
  });
});
