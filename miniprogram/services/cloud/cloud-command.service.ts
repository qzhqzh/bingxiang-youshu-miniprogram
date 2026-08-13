import type { AppSettings, RecipeProgress, StorageMode } from '../../domain/models';
import { seedIngredients } from '../../data/ingredients';
import { seedRecipes } from '../../data/recipes';
import { LocalV2Repository } from '../../repositories/local/local-v2.repository';
import type {
  CloudAuthState,
  LocalEntity,
  OptimisticEntityChange,
  SyncCommand,
  SyncEntityType,
} from '../../v2/models';

interface CommandContext {
  auth: CloudAuthState;
  accessToken: string;
  householdId: string;
  userId: string;
  deviceId: string;
}

export interface CloudPurchaseInput {
  ingredientId: string;
  quantity: number;
  unit: string;
  purchasedAt: string;
  storageMode: StorageMode;
  shelfLifeDaysOverride?: number;
  note?: string;
  shoppingItemId?: string;
}

function newId(prefix: string, now: number): string {
  return `${prefix}_${now.toString(36)}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`;
}

/** 云模式的唯一写入口：命令和乐观视图始终写进同一个家庭信封。 */
export class CloudCommandService {
  constructor(
    private readonly local: LocalV2Repository,
    private readonly requestSync: () => Promise<unknown>,
    private readonly now: () => number = Date.now,
  ) {}

  purchase(input: CloudPurchaseInput): SyncCommand {
    const context = this.context();
    const ingredient = seedIngredients.find((item) => item.id === input.ingredientId);
    if (!ingredient || input.unit !== ingredient.defaultUnit || !Number.isFinite(input.quantity) || input.quantity <= 0) {
      throw new Error('购入食材参数无效');
    }
    const occurredAt = this.now();
    const entityId = newId('batch', occurredAt);
    const command = this.command(context, 'PurchaseBatch', entityId, 0, input, occurredAt);
    const changes: OptimisticEntityChange[] = [{
      entityType: 'pantryBatch', entityId, version: 0, deleted: false,
      value: {
        id: entityId, householdId: context.householdId, ingredientId: input.ingredientId,
        quantity: input.quantity, originalQuantity: input.quantity, unit: input.unit,
        purchasedAt: input.purchasedAt, storageMode: input.storageMode, status: 'active',
        createdBy: context.userId, createdAt: occurredAt, updatedAt: occurredAt, version: 0,
        ...(input.shelfLifeDaysOverride === undefined ? {} : { shelfLifeDaysOverride: input.shelfLifeDaysOverride }),
        ...(input.note ? { note: input.note } : {}),
      },
    }];
    if (input.shoppingItemId) {
      const shopping = this.entity(context.householdId, 'shoppingItem', input.shoppingItemId);
      if (shopping && !shopping.deleted) {
        changes.push({
          entityType: 'shoppingItem', entityId: input.shoppingItemId, version: shopping.version, deleted: false,
          value: { ...(shopping.value as object), checked: true, updatedAt: occurredAt },
        });
      }
    }
    return this.queue(command, changes);
  }

  completeCooking(recipeId: string, servings: number): SyncCommand {
    const context = this.context();
    if (!seedRecipes.some((item) => item.id === recipeId) || !Number.isFinite(servings) || servings <= 0) {
      throw new Error('做菜参数无效');
    }
    const occurredAt = this.now();
    return this.queue(this.command(context, 'CompleteCooking', newId('cook', occurredAt), 0, {
      recipeId, servings,
    }, occurredAt));
  }

  addShoppingItem(ingredientId: string, suggestedQuantity: number, sourceRecipeId?: string): SyncCommand {
    const context = this.context();
    const ingredient = seedIngredients.find((item) => item.id === ingredientId);
    if (!ingredient || !Number.isFinite(suggestedQuantity) || suggestedQuantity <= 0) throw new Error('购物项参数无效');
    const occurredAt = this.now();
    const entityId = newId('shop', occurredAt);
    const payload = {
      ingredientId, suggestedQuantity, unit: ingredient.defaultUnit,
      ...(sourceRecipeId ? { sourceRecipeId } : {}),
    };
    const value = {
      id: entityId, householdId: context.householdId, ...payload, checked: false,
      createdBy: context.userId, createdAt: occurredAt, updatedAt: occurredAt, version: 0,
    };
    return this.queue(this.command(context, 'AddShoppingItem', entityId, 0, payload, occurredAt), [{
      entityType: 'shoppingItem', entityId, version: 0, deleted: false, value,
    }]);
  }

  checkShoppingItem(entityId: string, checked: boolean): SyncCommand {
    return this.updateEntityCommand('shoppingItem', entityId, 'CheckShoppingItem', { checked }, (value, now) => ({
      ...value, checked, updatedAt: now,
    }));
  }

  removeShoppingItem(entityId: string): SyncCommand {
    return this.updateEntityCommand('shoppingItem', entityId, 'RemoveShoppingItem', {}, (value, now) => ({
      ...value, deletedAt: now,
    }), true);
  }

  discardBatch(entityId: string): SyncCommand {
    return this.updateEntityCommand('pantryBatch', entityId, 'DiscardBatch', {}, (value, now) => ({
      ...value, quantity: 0, status: 'discarded', updatedAt: now,
    }));
  }

  unlockRecipe(recipeId: string): SyncCommand {
    const context = this.context();
    if (!seedRecipes.some((item) => item.id === recipeId)) throw new Error('食谱不存在');
    const occurredAt = this.now();
    const entityId = `${context.userId}:${recipeId}`;
    const current = this.entity(context.householdId, 'recipeProgress', entityId);
    const value: RecipeProgress & { householdId: string; userId: string; version: number } = {
      ...(current?.value as RecipeProgress | undefined ?? { recipeId, cookCount: 0 }),
      recipeId, householdId: context.householdId, userId: context.userId,
      status: 'mastered', unlockedAt: occurredAt, version: current?.version ?? 0,
    };
    return this.queue(this.command(context, 'UnlockRecipe', recipeId, current?.version ?? 0, { recipeId }, occurredAt), [{
      entityType: 'recipeProgress', entityId, version: current?.version ?? 0, deleted: false, value,
    }]);
  }

  updatePreferences(settings: AppSettings): SyncCommand {
    const context = this.context();
    const occurredAt = this.now();
    const current = this.entity(context.householdId, 'preferences', context.userId);
    const payload = {
      freshnessReminderDays: settings.freshnessReminderDays,
      defaultStorageMode: settings.defaultStorageMode,
      favoriteRecipeIds: settings.favoriteRecipeIds ?? [],
    };
    const value = {
      ...payload, householdId: context.householdId, userId: context.userId,
      version: current?.version ?? 0, updatedAt: occurredAt,
    };
    return this.queue(this.command(
      context, 'UpdatePreferences', context.userId, current?.version ?? 0, payload, occurredAt,
    ), [{ entityType: 'preferences', entityId: context.userId, version: current?.version ?? 0, deleted: false, value }]);
  }

  private updateEntityCommand<TName extends 'CheckShoppingItem' | 'RemoveShoppingItem' | 'DiscardBatch'>(
    entityType: 'shoppingItem' | 'pantryBatch',
    entityId: string,
    name: TName,
    payload: TName extends 'CheckShoppingItem' ? { checked: boolean } : Record<string, never>,
    update: (value: Record<string, unknown>, now: number) => Record<string, unknown>,
    deleted = false,
  ): SyncCommand {
    const context = this.context();
    const current = this.entity(context.householdId, entityType, entityId);
    if (!current || current.deleted) throw new Error('要修改的数据不存在或已被删除');
    const occurredAt = this.now();
    const command = this.command(context, name, entityId, current.version, payload, occurredAt) as SyncCommand;
    return this.queue(command, [{
      entityType, entityId, version: current.version, deleted,
      value: update(current.value as Record<string, unknown>, occurredAt),
    }]);
  }

  private command(
    context: CommandContext,
    name: SyncCommand['command'],
    entityId: string,
    baseVersion: number,
    payload: unknown,
    occurredAt: number,
  ): SyncCommand {
    return {
      mutationId: newId('mutation', occurredAt), deviceId: context.deviceId,
      householdId: context.householdId, command: name, entityId, baseVersion,
      payload, clientOccurredAt: new Date(occurredAt).toISOString(),
    } as SyncCommand;
  }

  private queue(command: SyncCommand, changes: OptimisticEntityChange[] = []): SyncCommand {
    this.local.enqueue(command, changes);
    void this.requestSync().catch(() => undefined);
    return command;
  }

  private entity(householdId: string, type: SyncEntityType, id: string): LocalEntity | undefined {
    return this.local.envelope(householdId).entities[type]?.[id];
  }

  private context(): CommandContext {
    const auth = this.local.auth();
    if (auth.mode !== 'cloud' || !auth.accessToken || !auth.activeHouseholdId || !auth.user) {
      throw new Error('请先登录并选择家庭');
    }
    return {
      auth, accessToken: auth.accessToken, householdId: auth.activeHouseholdId,
      userId: auth.user.id, deviceId: this.local.device().deviceId,
    };
  }
}
