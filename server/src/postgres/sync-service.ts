import type { QueryResultRow } from 'pg';
import type { AppSettings, RecipeProgress } from '../../../miniprogram/domain/models.js';
import { completeCooking, parseDateOnly, refreshRecipeProgress, unlockRecipe } from '../../../miniprogram/domain/rules.js';
import { seedIngredients } from '../../../miniprogram/data/ingredients.js';
import { seedRecipes } from '../../../miniprogram/data/recipes.js';
import type { PullResult } from '../api-service.js';
import { ApiError } from '../errors.js';
import { newId } from '../security.js';
import type {
  InventoryMovement,
  MemberPreferences,
  Permission,
  PushResult,
  ServerCookingRecord,
  ServerPantryBatch,
  ServerRecipeProgress,
  ServerShoppingItem,
  SyncCommand,
} from '../types.js';
import {
  PostgresMutationExecutor,
  type MutationWorkResult,
  type PgClientLike,
  type PgPoolLike,
  type PostgresMutationContext,
} from './mutation-executor.js';
import { PostgresQueryStore } from './query-store.js';

const DEFAULT_SETTINGS: AppSettings = {
  freshnessReminderDays: 3,
  defaultStorageMode: 'chilled',
  favoriteRecipeIds: [],
};

const commandPermission: Record<SyncCommand['command'], Permission> = {
  PurchaseBatch: 'inventory:write',
  CompleteCooking: 'cooking:write',
  AddShoppingItem: 'shopping:write',
  CheckShoppingItem: 'shopping:write',
  RemoveShoppingItem: 'shopping:write',
  DiscardBatch: 'inventory:write',
  UnlockRecipe: 'cooking:write',
  UpdatePreferences: 'household:read',
};

interface BatchRow extends QueryResultRow {
  id: string;
  household_id: string;
  ingredient_id: string;
  quantity: string | number;
  original_quantity: string | number;
  unit: string;
  purchased_at: Date | string;
  storage_mode: ServerPantryBatch['storageMode'];
  shelf_life_days_override: number | null;
  note: string | null;
  status: ServerPantryBatch['status'];
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
  version: string | number;
  deleted_at: Date | string | null;
}

interface ShoppingRow extends QueryResultRow {
  id: string;
  household_id: string;
  ingredient_id: string;
  suggested_quantity: string | number;
  unit: string;
  source_recipe_id: string | null;
  checked: boolean;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
  version: string | number;
  deleted_at: Date | string | null;
}

interface ProgressRow extends QueryResultRow {
  household_id: string;
  user_id: string;
  recipe_id: string;
  status: RecipeProgress['status'];
  unlocked_at: Date | string | null;
  cook_count: number;
  last_cooked_at: Date | string | null;
  version: string | number;
}

interface PreferenceRow extends QueryResultRow {
  household_id: string;
  user_id: string;
  freshness_reminder_days: number;
  default_storage_mode: MemberPreferences['defaultStorageMode'];
  favorite_recipe_ids: unknown;
  version: string | number;
  updated_at: Date | string;
}

interface IngredientRow extends QueryResultRow { ingredient_id: string }
interface IdRow extends QueryResultRow { id: string }

function timestamp(value: Date | string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error('数据库返回了无效时间');
  return parsed;
}

function dateOnly(value: Date | string): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10);
}

function batchFromRow(row: BatchRow): ServerPantryBatch {
  return {
    id: row.id, householdId: row.household_id, ingredientId: row.ingredient_id,
    quantity: Number(row.quantity), originalQuantity: Number(row.original_quantity), unit: row.unit,
    purchasedAt: dateOnly(row.purchased_at), storageMode: row.storage_mode,
    ...(row.shelf_life_days_override === null ? {} : { shelfLifeDaysOverride: row.shelf_life_days_override }),
    ...(row.note === null ? {} : { note: row.note }), status: row.status, createdBy: row.created_by,
    createdAt: timestamp(row.created_at)!, updatedAt: timestamp(row.updated_at)!, version: Number(row.version),
    ...(row.deleted_at ? { deletedAt: timestamp(row.deleted_at)! } : {}),
  };
}

function shoppingFromRow(row: ShoppingRow): ServerShoppingItem {
  return {
    id: row.id, householdId: row.household_id, ingredientId: row.ingredient_id,
    suggestedQuantity: Number(row.suggested_quantity), unit: row.unit,
    ...(row.source_recipe_id ? { sourceRecipeId: row.source_recipe_id } : {}), checked: row.checked,
    createdBy: row.created_by, createdAt: timestamp(row.created_at)!, updatedAt: timestamp(row.updated_at)!,
    version: Number(row.version), ...(row.deleted_at ? { deletedAt: timestamp(row.deleted_at)! } : {}),
  };
}

function progressFromRow(row: ProgressRow): ServerRecipeProgress {
  return {
    householdId: row.household_id, userId: row.user_id, recipeId: row.recipe_id, status: row.status,
    ...(row.unlocked_at ? { unlockedAt: timestamp(row.unlocked_at)! } : {}), cookCount: Number(row.cook_count),
    ...(row.last_cooked_at ? { lastCookedAt: timestamp(row.last_cooked_at)! } : {}), version: Number(row.version),
  };
}

function preferencesFromRow(row: PreferenceRow): MemberPreferences {
  return {
    householdId: row.household_id, userId: row.user_id,
    freshnessReminderDays: Number(row.freshness_reminder_days), defaultStorageMode: row.default_storage_mode,
    favoriteRecipeIds: Array.isArray(row.favorite_recipe_ids) ? row.favorite_recipe_ids as string[] : [],
    version: Number(row.version), updatedAt: timestamp(row.updated_at)!,
  };
}

/** PostgreSQL 同步命令服务：鉴权、幂等结果、领域写入、cursor 与 change log 使用同一事务。 */
export class PostgresSyncService {
  private readonly now: () => number;
  private readonly queryStore: PostgresQueryStore;
  private readonly executor: PostgresMutationExecutor;

  constructor(private readonly pool: PgPoolLike, options: { now?: () => number; catalogVersion?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.queryStore = new PostgresQueryStore({
      query: (text, values) => this.withClientQuery(text, values),
    }, { now: this.now, ...(options.catalogVersion === undefined ? {} : { catalogVersion: options.catalogVersion }) });
    this.executor = new PostgresMutationExecutor(pool, { now: this.now });
  }

  async push(accessToken: string, command: SyncCommand): Promise<PushResult> {
    this.validateCommand(command);
    const principal = await this.queryStore.authenticate(accessToken);
    return this.executor.execute(
      {
        userId: principal.user.id,
        householdId: command.householdId,
        mutationId: command.mutationId,
        commandName: command.command,
        permission: commandPermission[command.command],
      },
      (context) => this.apply(context, principal.user.id, command),
    );
  }

  async pull(accessToken: string, householdId: string, cursor: number, limit?: number): Promise<PullResult> {
    const principal = await this.queryStore.authenticate(accessToken);
    return this.queryStore.pull(householdId, principal.user.id, cursor, limit);
  }

  private apply(context: PostgresMutationContext, userId: string, command: SyncCommand): Promise<MutationWorkResult<unknown>> {
    switch (command.command) {
      case 'PurchaseBatch': return this.purchase(context, userId, command);
      case 'CompleteCooking': return this.cook(context, userId, command);
      case 'AddShoppingItem': return this.addShopping(context, userId, command);
      case 'CheckShoppingItem': return this.checkShopping(context, command);
      case 'RemoveShoppingItem': return this.removeShopping(context, command);
      case 'DiscardBatch': return this.discard(context, userId, command);
      case 'UnlockRecipe': return this.unlock(context, userId, command);
      case 'UpdatePreferences': return this.updatePreferences(context, userId, command);
    }
  }

  private async purchase(
    context: PostgresMutationContext,
    userId: string,
    command: Extract<SyncCommand, { command: 'PurchaseBatch' }>,
  ): Promise<MutationWorkResult<ServerPantryBatch>> {
    const ingredient = seedIngredients.find((item) => item.id === command.payload.ingredientId);
    if (!ingredient) throw new ApiError('VALIDATION_ERROR', '未知食材', 400);
    if (!Number.isFinite(command.payload.quantity) || command.payload.quantity <= 0) {
      throw new ApiError('VALIDATION_ERROR', '购入数量无效', 400);
    }
    if (command.payload.unit !== ingredient.defaultUnit) throw new ApiError('VALIDATION_ERROR', '购入单位与食材不一致', 400);
    try { parseDateOnly(command.payload.purchasedAt); }
    catch { throw new ApiError('VALIDATION_ERROR', '购入日期无效', 400); }
    if (command.payload.shelfLifeDaysOverride !== undefined
      && (!Number.isInteger(command.payload.shelfLifeDaysOverride) || command.payload.shelfLifeDaysOverride <= 0)) {
      throw new ApiError('VALIDATION_ERROR', '自定义保质期必须是正整数', 400);
    }
    if (command.payload.note && command.payload.note.length > 200) {
      throw new ApiError('VALIDATION_ERROR', '备注不能超过 200 个字符', 400);
    }
    if (command.baseVersion !== 0) throw new ApiError('VERSION_CONFLICT', '新增批次的 baseVersion 必须为 0', 409);
    const now = this.now();
    let shopping: ServerShoppingItem | undefined;
    if (command.payload.shoppingItemId) {
      const selected = await context.client.query<ShoppingRow>(
        `SELECT id, household_id, ingredient_id, suggested_quantity, unit, source_recipe_id, checked,
                created_by, created_at, updated_at, version, deleted_at
         FROM shopping_items WHERE household_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE`,
        [command.householdId, command.payload.shoppingItemId],
      );
      if (!selected.rows[0]) throw new ApiError('NOT_FOUND', '购物项不存在', 404);
      shopping = shoppingFromRow(selected.rows[0]);
    }
    const inserted = await context.client.query<BatchRow>(
      `INSERT INTO pantry_batches
         (id, household_id, ingredient_id, quantity, original_quantity, unit, purchased_at, storage_mode,
          shelf_life_days_override, note, status, created_by, created_at, updated_at, version)
       VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8, $9, 'active', $10, $11, $11, 1)
       ON CONFLICT DO NOTHING
       RETURNING id, household_id, ingredient_id, quantity, original_quantity, unit, purchased_at, storage_mode,
                 shelf_life_days_override, note, status, created_by, created_at, updated_at, version, deleted_at`,
      [command.entityId, command.householdId, command.payload.ingredientId, command.payload.quantity,
        command.payload.unit, command.payload.purchasedAt, command.payload.storageMode,
        command.payload.shelfLifeDaysOverride ?? null, command.payload.note ?? null, userId, new Date(now)],
    );
    if (!inserted.rows[0]) throw new ApiError('VERSION_CONFLICT', '批次 ID 已存在', 409);
    const batch = batchFromRow(inserted.rows[0]);
    const movement: InventoryMovement = {
      id: newId('mov'), householdId: command.householdId, pantryBatchId: batch.id,
      ingredientId: batch.ingredientId, type: 'purchase', quantityDelta: batch.quantity, unit: batch.unit,
      actorUserId: userId, sourceMutationId: command.mutationId, occurredAt: now,
    };
    await this.insertMovement(context.client, movement);
    const changes: MutationWorkResult<ServerPantryBatch>['changes'] = [
      { entityType: 'pantryBatch', entityId: batch.id, operation: 'upsert', version: batch.version, payload: batch },
      { entityType: 'inventoryMovement', entityId: movement.id, operation: 'upsert', version: 1, payload: movement },
    ];
    if (shopping) {
      const updated = await context.client.query<ShoppingRow>(
        `UPDATE shopping_items SET checked = true, updated_at = $3, version = version + 1
         WHERE household_id = $1 AND id = $2
         RETURNING id, household_id, ingredient_id, suggested_quantity, unit, source_recipe_id, checked,
                   created_by, created_at, updated_at, version, deleted_at`,
        [command.householdId, shopping.id, new Date(now)],
      );
      const nextShopping = shoppingFromRow(updated.rows[0]!);
      changes.push({
        entityType: 'shoppingItem', entityId: nextShopping.id, operation: 'upsert',
        version: nextShopping.version, payload: nextShopping,
      });
    }
    return { canonical: batch, changes };
  }

  private async addShopping(
    context: PostgresMutationContext,
    userId: string,
    command: Extract<SyncCommand, { command: 'AddShoppingItem' }>,
  ): Promise<MutationWorkResult<ServerShoppingItem>> {
    const ingredient = seedIngredients.find((item) => item.id === command.payload.ingredientId);
    if (!ingredient) throw new ApiError('VALIDATION_ERROR', '未知食材', 400);
    if (!Number.isFinite(command.payload.suggestedQuantity) || command.payload.suggestedQuantity <= 0) {
      throw new ApiError('VALIDATION_ERROR', '建议数量无效', 400);
    }
    if (command.payload.unit !== ingredient.defaultUnit) throw new ApiError('VALIDATION_ERROR', '购物项单位与食材不一致', 400);
    if (command.payload.sourceRecipeId && !seedRecipes.some((item) => item.id === command.payload.sourceRecipeId)) {
      throw new ApiError('VALIDATION_ERROR', '来源食谱不存在', 400);
    }
    if (command.baseVersion !== 0) throw new ApiError('VERSION_CONFLICT', '新增购物项的 baseVersion 必须为 0', 409);
    const now = this.now();
    const result = await context.client.query<ShoppingRow>(
      `INSERT INTO shopping_items
         (id, household_id, ingredient_id, suggested_quantity, unit, source_recipe_id, checked,
          created_by, created_at, updated_at, version)
       VALUES ($1, $2, $3, $4, $5, $6, false, $7, $8, $8, 1)
       ON CONFLICT DO NOTHING
       RETURNING id, household_id, ingredient_id, suggested_quantity, unit, source_recipe_id, checked,
                 created_by, created_at, updated_at, version, deleted_at`,
      [command.entityId, command.householdId, command.payload.ingredientId, command.payload.suggestedQuantity,
        command.payload.unit, command.payload.sourceRecipeId ?? null, userId, new Date(now)],
    );
    if (!result.rows[0]) throw new ApiError('VERSION_CONFLICT', '购物项 ID 已存在', 409);
    const item = shoppingFromRow(result.rows[0]);
    return { canonical: item, changes: [
      { entityType: 'shoppingItem', entityId: item.id, operation: 'upsert', version: item.version, payload: item },
    ] };
  }

  private async checkShopping(
    context: PostgresMutationContext,
    command: Extract<SyncCommand, { command: 'CheckShoppingItem' }>,
  ): Promise<MutationWorkResult<ServerShoppingItem>> {
    const current = await this.lockShopping(context.client, command.householdId, command.entityId, false);
    if (current.checked === command.payload.checked) return { canonical: current, changes: [] };
    if (current.version !== command.baseVersion) {
      throw new ApiError('VERSION_CONFLICT', '购物项已被其他成员修改', 409, { serverValue: current });
    }
    const result = await context.client.query<ShoppingRow>(
      `UPDATE shopping_items SET checked = $3, updated_at = $4, version = version + 1
       WHERE household_id = $1 AND id = $2 AND deleted_at IS NULL
       RETURNING id, household_id, ingredient_id, suggested_quantity, unit, source_recipe_id, checked,
                 created_by, created_at, updated_at, version, deleted_at`,
      [command.householdId, command.entityId, command.payload.checked, new Date(this.now())],
    );
    const next = shoppingFromRow(result.rows[0]!);
    return { canonical: next, changes: [
      { entityType: 'shoppingItem', entityId: next.id, operation: 'upsert', version: next.version, payload: next },
    ] };
  }

  private async removeShopping(
    context: PostgresMutationContext,
    command: Extract<SyncCommand, { command: 'RemoveShoppingItem' }>,
  ): Promise<MutationWorkResult<{ id: string; deletedAt: number; version: number }>> {
    const current = await this.lockShopping(context.client, command.householdId, command.entityId, true);
    if (current.deletedAt) {
      return { canonical: { id: current.id, deletedAt: current.deletedAt, version: current.version }, changes: [] };
    }
    if (current.version !== command.baseVersion) {
      throw new ApiError('VERSION_CONFLICT', '购物项已被其他成员修改', 409, { serverValue: current });
    }
    const deletedAt = this.now();
    const result = await context.client.query<ShoppingRow>(
      `UPDATE shopping_items SET deleted_at = $3, updated_at = $3, version = version + 1
       WHERE household_id = $1 AND id = $2
       RETURNING id, household_id, ingredient_id, suggested_quantity, unit, source_recipe_id, checked,
                 created_by, created_at, updated_at, version, deleted_at`,
      [command.householdId, command.entityId, new Date(deletedAt)],
    );
    const next = shoppingFromRow(result.rows[0]!);
    const tombstone = { id: next.id, deletedAt: next.deletedAt!, version: next.version };
    return { canonical: tombstone, changes: [
      { entityType: 'shoppingItem', entityId: next.id, operation: 'delete', version: next.version, payload: tombstone },
    ] };
  }

  private async discard(
    context: PostgresMutationContext,
    userId: string,
    command: Extract<SyncCommand, { command: 'DiscardBatch' }>,
  ): Promise<MutationWorkResult<ServerPantryBatch>> {
    const result = await context.client.query<BatchRow>(
      `SELECT id, household_id, ingredient_id, quantity, original_quantity, unit, purchased_at, storage_mode,
              shelf_life_days_override, note, status, created_by, created_at, updated_at, version, deleted_at
       FROM pantry_batches WHERE household_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE`,
      [command.householdId, command.entityId],
    );
    if (!result.rows[0]) throw new ApiError('NOT_FOUND', '批次不存在', 404);
    const current = batchFromRow(result.rows[0]);
    if (current.status === 'discarded') return { canonical: current, changes: [] };
    if (current.version !== command.baseVersion) {
      throw new ApiError('VERSION_CONFLICT', '批次已被其他成员修改', 409, { serverValue: current });
    }
    const now = this.now();
    const updated = await context.client.query<BatchRow>(
      `UPDATE pantry_batches SET quantity = 0, status = 'discarded', updated_at = $3, version = version + 1
       WHERE household_id = $1 AND id = $2
       RETURNING id, household_id, ingredient_id, quantity, original_quantity, unit, purchased_at, storage_mode,
                 shelf_life_days_override, note, status, created_by, created_at, updated_at, version, deleted_at`,
      [command.householdId, command.entityId, new Date(now)],
    );
    const next = batchFromRow(updated.rows[0]!);
    const changes: MutationWorkResult<ServerPantryBatch>['changes'] = [
      { entityType: 'pantryBatch', entityId: next.id, operation: 'upsert', version: next.version, payload: next },
    ];
    if (current.quantity > 0) {
      const movement: InventoryMovement = {
        id: newId('mov'), householdId: command.householdId, pantryBatchId: current.id,
        ingredientId: current.ingredientId, type: 'discard', quantityDelta: -current.quantity, unit: current.unit,
        actorUserId: userId, sourceMutationId: command.mutationId, occurredAt: now,
      };
      await this.insertMovement(context.client, movement);
      changes.push({ entityType: 'inventoryMovement', entityId: movement.id, operation: 'upsert', version: 1, payload: movement });
    }
    return { canonical: next, changes };
  }

  private async unlock(
    context: PostgresMutationContext,
    userId: string,
    command: Extract<SyncCommand, { command: 'UnlockRecipe' }>,
  ): Promise<MutationWorkResult<ServerRecipeProgress>> {
    if (!seedRecipes.some((item) => item.id === command.payload.recipeId)) {
      throw new ApiError('VALIDATION_ERROR', '未知食谱', 400);
    }
    const loaded = await this.loadProgress(context.client, command.householdId, userId);
    let unlocked: RecipeProgress[];
    try { unlocked = unlockRecipe(loaded.progress, command.payload.recipeId, this.now()); }
    catch (error) {
      throw new ApiError('MUTATION_REJECTED', error instanceof Error ? error.message : '食谱无法解锁', 409);
    }
    const changed = unlocked.find((item) => item.recipeId === command.payload.recipeId)!;
    const saved = await this.saveProgress(context.client, command.householdId, userId, changed);
    return { canonical: saved, changes: [
      { entityType: 'recipeProgress', entityId: `${userId}:${saved.recipeId}`, operation: 'upsert', version: saved.version, payload: saved },
    ] };
  }

  private async updatePreferences(
    context: PostgresMutationContext,
    userId: string,
    command: Extract<SyncCommand, { command: 'UpdatePreferences' }>,
  ): Promise<MutationWorkResult<MemberPreferences>> {
    const selected = await context.client.query<PreferenceRow>(
      `SELECT household_id, user_id, freshness_reminder_days, default_storage_mode, favorite_recipe_ids,
              version, updated_at
       FROM member_preferences WHERE household_id = $1 AND user_id = $2 FOR UPDATE`,
      [command.householdId, userId],
    );
    const current: MemberPreferences = selected.rows[0] ? preferencesFromRow(selected.rows[0]) : {
      ...DEFAULT_SETTINGS, householdId: command.householdId, userId, version: 0, updatedAt: this.now(),
    };
    if (current.version !== command.baseVersion) {
      throw new ApiError('VERSION_CONFLICT', '偏好设置已在其他设备修改', 409, { serverValue: current });
    }
    const favoriteRecipeIds = [...new Set(command.payload.favoriteRecipeIds ?? current.favoriteRecipeIds ?? [])];
    if (!favoriteRecipeIds.every((id) => seedRecipes.some((recipe) => recipe.id === id))) {
      throw new ApiError('VALIDATION_ERROR', '收藏中包含未知食谱', 400);
    }
    const reminderDays = command.payload.freshnessReminderDays ?? current.freshnessReminderDays;
    if (!Number.isInteger(reminderDays) || reminderDays < 1 || reminderDays > 30) {
      throw new ApiError('VALIDATION_ERROR', '提醒范围应为 1–30 天', 400);
    }
    const storageMode = command.payload.defaultStorageMode ?? current.defaultStorageMode;
    const updated = await context.client.query<PreferenceRow>(
      `INSERT INTO member_preferences
         (household_id, user_id, freshness_reminder_days, default_storage_mode, favorite_recipe_ids, version, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, 1, $6)
       ON CONFLICT (household_id, user_id) DO UPDATE
         SET freshness_reminder_days = EXCLUDED.freshness_reminder_days,
             default_storage_mode = EXCLUDED.default_storage_mode,
             favorite_recipe_ids = EXCLUDED.favorite_recipe_ids,
             version = member_preferences.version + 1,
             updated_at = EXCLUDED.updated_at
       RETURNING household_id, user_id, freshness_reminder_days, default_storage_mode, favorite_recipe_ids,
                 version, updated_at`,
      [command.householdId, userId, reminderDays, storageMode, JSON.stringify(favoriteRecipeIds), new Date(this.now())],
    );
    const next = preferencesFromRow(updated.rows[0]!);
    return { canonical: next, changes: [
      { entityType: 'preferences', entityId: userId, operation: 'upsert', version: next.version, payload: next },
    ] };
  }

  private async cook(
    context: PostgresMutationContext,
    userId: string,
    command: Extract<SyncCommand, { command: 'CompleteCooking' }>,
  ): Promise<MutationWorkResult<ServerCookingRecord>> {
    if (!Number.isFinite(command.payload.servings) || command.payload.servings <= 0) {
      throw new ApiError('VALIDATION_ERROR', '份数无效', 400);
    }
    const recipe = seedRecipes.find((item) => item.id === command.payload.recipeId);
    if (!recipe) throw new ApiError('VALIDATION_ERROR', '未知食谱', 400);
    const existing = await context.client.query<IdRow>(
      'SELECT id FROM cooking_records WHERE household_id = $1 AND id = $2 FOR UPDATE',
      [command.householdId, command.entityId],
    );
    if (existing.rows[0]) throw new ApiError('VERSION_CONFLICT', '做菜记录 ID 已存在', 409);
    const loaded = await this.loadProgress(context.client, command.householdId, userId);
    if (loaded.progress.find((item) => item.recipeId === recipe.id)?.status !== 'mastered') {
      throw new ApiError('MUTATION_REJECTED', '请先解锁并掌握这个食谱', 409);
    }
    const locked = await context.lockCookingPlan(recipe, command.payload.servings, seedIngredients);
    const now = this.now();
    const completed = completeCooking(
      recipe, command.payload.servings, locked.batches, seedIngredients, loaded.progress, now, command.entityId,
    );
    const changes: MutationWorkResult<ServerCookingRecord>['changes'] = [];
    const useByBatch = new Map<string, typeof completed.record.consumptions[number]>();
    completed.record.consumptions.forEach((item) => {
      const existingAllocation = useByBatch.get(item.pantryBatchId);
      useByBatch.set(item.pantryBatchId, existingAllocation
        ? { ...existingAllocation, quantity: existingAllocation.quantity + item.quantity }
        : { ...item });
    });
    for (const allocation of useByBatch.values()) {
      const current = locked.batches.find((item) => item.id === allocation.pantryBatchId)!;
      const quantity = Math.max(0, current.quantity - allocation.quantity);
      const updated = await context.client.query<BatchRow>(
        `UPDATE pantry_batches SET quantity = $3, status = $4, updated_at = $5, version = version + 1
         WHERE household_id = $1 AND id = $2 AND version = $6
         RETURNING id, household_id, ingredient_id, quantity, original_quantity, unit, purchased_at, storage_mode,
                   shelf_life_days_override, note, status, created_by, created_at, updated_at, version, deleted_at`,
        [command.householdId, current.id, quantity, quantity <= 0 ? 'consumed' : current.status, new Date(now), current.version],
      );
      if (!updated.rows[0]) throw new ApiError('INVENTORY_CONFLICT', '库存批次已发生变化，请重新确认', 409);
      const nextBatch = batchFromRow(updated.rows[0]);
      changes.push({ entityType: 'pantryBatch', entityId: nextBatch.id, operation: 'upsert', version: nextBatch.version, payload: nextBatch });
      const movement: InventoryMovement = {
        id: newId('mov'), householdId: command.householdId, pantryBatchId: current.id,
        ingredientId: allocation.ingredientId, type: 'cook_consume', quantityDelta: -allocation.quantity,
        unit: allocation.unit, actorUserId: userId, sourceMutationId: command.mutationId, occurredAt: now,
      };
      await this.insertMovement(context.client, movement);
      changes.push({ entityType: 'inventoryMovement', entityId: movement.id, operation: 'upsert', version: 1, payload: movement });
    }
    await context.client.query(
      `INSERT INTO cooking_records (id, household_id, recipe_id, cooked_at, servings, actor_user_id, mutation_id, version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 1)`,
      [command.entityId, command.householdId, recipe.id, new Date(now), command.payload.servings, userId, command.mutationId],
    );
    for (const allocation of useByBatch.values()) {
      await context.client.query(
        `INSERT INTO cooking_consumptions
           (cooking_record_id, household_id, pantry_batch_id, ingredient_id, quantity, unit)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [command.entityId, command.householdId, allocation.pantryBatchId, allocation.ingredientId, allocation.quantity, allocation.unit],
      );
    }
    const record: ServerCookingRecord = {
      id: command.entityId, householdId: command.householdId, recipeId: recipe.id, cookedAt: now,
      servings: command.payload.servings, consumptions: [...useByBatch.values()], actorUserId: userId,
      mutationId: command.mutationId, version: 1,
    };
    changes.push({ entityType: 'cookingRecord', entityId: record.id, operation: 'upsert', version: 1, payload: record });
    const updatedProgress = completed.progress.find((item) => item.recipeId === recipe.id)!;
    const progress = await this.saveProgress(context.client, command.householdId, userId, updatedProgress);
    changes.push({
      entityType: 'recipeProgress', entityId: `${userId}:${recipe.id}`, operation: 'upsert',
      version: progress.version, payload: progress,
    });
    return { canonical: record, changes };
  }

  private async loadProgress(client: PgClientLike, householdId: string, userId: string) {
    const stored = await client.query<ProgressRow>(
      `SELECT household_id, user_id, recipe_id, status, unlocked_at, cook_count, last_cooked_at, version
       FROM recipe_progress WHERE household_id = $1 AND user_id = $2 FOR UPDATE`,
      [householdId, userId],
    );
    const purchased = await client.query<IngredientRow>(
      `SELECT DISTINCT ingredient_id FROM inventory_movements
       WHERE household_id = $1 AND movement_type = 'purchase'`,
      [householdId],
    );
    const rows = stored.rows.map(progressFromRow);
    return {
      stored: new Map(rows.map((item) => [item.recipeId, item])),
      progress: refreshRecipeProgress(seedRecipes, rows, purchased.rows.map((item) => item.ingredient_id)),
    };
  }

  private async saveProgress(
    client: PgClientLike,
    householdId: string,
    userId: string,
    progress: RecipeProgress,
  ): Promise<ServerRecipeProgress> {
    const result = await client.query<ProgressRow>(
      `INSERT INTO recipe_progress
         (household_id, user_id, recipe_id, status, unlocked_at, cook_count, last_cooked_at, version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 1)
       ON CONFLICT (household_id, user_id, recipe_id) DO UPDATE
         SET status = EXCLUDED.status, unlocked_at = EXCLUDED.unlocked_at,
             cook_count = EXCLUDED.cook_count, last_cooked_at = EXCLUDED.last_cooked_at,
             version = recipe_progress.version + 1
       RETURNING household_id, user_id, recipe_id, status, unlocked_at, cook_count, last_cooked_at, version`,
      [householdId, userId, progress.recipeId, progress.status,
        progress.unlockedAt ? new Date(progress.unlockedAt) : null, progress.cookCount,
        progress.lastCookedAt ? new Date(progress.lastCookedAt) : null],
    );
    return progressFromRow(result.rows[0]!);
  }

  private async lockShopping(client: PgClientLike, householdId: string, id: string, includeDeleted: boolean) {
    const result = await client.query<ShoppingRow>(
      `SELECT id, household_id, ingredient_id, suggested_quantity, unit, source_recipe_id, checked,
              created_by, created_at, updated_at, version, deleted_at
       FROM shopping_items WHERE household_id = $1 AND id = $2${includeDeleted ? '' : ' AND deleted_at IS NULL'} FOR UPDATE`,
      [householdId, id],
    );
    if (!result.rows[0]) throw new ApiError('NOT_FOUND', '购物项不存在', 404);
    return shoppingFromRow(result.rows[0]);
  }

  private async insertMovement(client: PgClientLike, movement: InventoryMovement): Promise<void> {
    await client.query(
      `INSERT INTO inventory_movements
         (id, household_id, pantry_batch_id, ingredient_id, movement_type, quantity_delta, unit,
          actor_user_id, source_mutation_id, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [movement.id, movement.householdId, movement.pantryBatchId, movement.ingredientId, movement.type,
        movement.quantityDelta, movement.unit, movement.actorUserId, movement.sourceMutationId,
        new Date(movement.occurredAt)],
    );
  }

  private validateCommand(command: SyncCommand): void {
    if (!command.mutationId || !command.deviceId || !command.householdId || !command.entityId) {
      throw new ApiError('VALIDATION_ERROR', '同步命令缺少必要标识', 400);
    }
    if (!Number.isInteger(command.baseVersion) || command.baseVersion < 0) {
      throw new ApiError('VALIDATION_ERROR', 'baseVersion 无效', 400);
    }
    if (Number.isNaN(Date.parse(command.clientOccurredAt))) {
      throw new ApiError('VALIDATION_ERROR', 'clientOccurredAt 无效', 400);
    }
  }

  private async withClientQuery<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) {
    const client = await this.pool.connect();
    try { return await client.query<R>(text, values); }
    finally { client.release(); }
  }
}
