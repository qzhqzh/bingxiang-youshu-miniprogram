import type { QueryResultRow } from 'pg';
import { validateImportJson } from '../../../miniprogram/services/data-transfer.js';
import { ApiError } from '../errors.js';
import { can } from '../rbac.js';
import { checksum, newId } from '../security.js';
import type {
  HouseholdRole,
  InventoryMovement,
  MemberPreferences,
  MigrationSummary,
  ServerCookingRecord,
  ServerPantryBatch,
  ServerRecipeProgress,
  ServerShoppingItem,
} from '../types.js';
import { PostgresMutationContext, type PgClientLike, type PgPoolLike } from './mutation-executor.js';
import { PostgresQueryStore } from './query-store.js';

interface MigrationServiceOptions {
  now?: () => number;
  statementTimeoutMs?: number;
  lockTimeoutMs?: number;
}

interface MigrationRow extends QueryResultRow {
  user_id: string;
  import_batch_id: string;
  household_id: string;
  checksum: string;
  summary: MigrationSummary | string;
  status: MigrationSummary['status'];
}

interface MembershipRow extends QueryResultRow { role: HouseholdRole; status: string }
interface OccupiedRow extends QueryResultRow { occupied: boolean }

function summaryFromRow(row: MigrationRow): MigrationSummary {
  const stored = typeof row.summary === 'string' ? JSON.parse(row.summary) as MigrationSummary : row.summary;
  return { ...stored, checksum: row.checksum, status: row.status };
}

function validatedSource(source: string) {
  try { return validateImportJson(source); }
  catch (error) {
    throw new ApiError('VALIDATION_ERROR', error instanceof Error ? error.message : '迁移数据无效', 400);
  }
}

/** PostgreSQL v1 显式迁移服务：预检与提交分离，完整导入和同步日志同事务提交。 */
export class PostgresMigrationService {
  private readonly now: () => number;
  private readonly statementTimeoutMs: number;
  private readonly lockTimeoutMs: number;
  private readonly queryStore: PostgresQueryStore;

  constructor(private readonly pool: PgPoolLike, options: MigrationServiceOptions = {}) {
    this.now = options.now ?? Date.now;
    this.statementTimeoutMs = options.statementTimeoutMs ?? 30_000;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 2_000;
    this.queryStore = new PostgresQueryStore({
      query: (text, values) => this.withClientQuery(text, values),
    }, { now: this.now });
  }

  async prepareV1Migration(
    accessToken: string,
    householdId: string,
    importBatchId: string,
    source: string,
  ): Promise<MigrationSummary> {
    if (!importBatchId.trim()) throw new ApiError('VALIDATION_ERROR', '迁移批次 ID 不能为空', 400);
    const validated = validatedSource(source);
    const sourceChecksum = checksum(source);
    const principal = await this.queryStore.authenticate(accessToken);
    return this.transaction(async (client) => {
      await this.lock(client, `migration:${principal.user.id}:${importBatchId}`);
      await this.requireInventoryWriter(client, householdId, principal.user.id);
      const existing = await client.query<MigrationRow>(
        `SELECT user_id, import_batch_id, household_id, checksum, summary, status
         FROM v1_migrations WHERE user_id = $1 AND import_batch_id = $2 FOR UPDATE`,
        [principal.user.id, importBatchId],
      );
      if (existing.rows[0]) {
        const previous = summaryFromRow(existing.rows[0]);
        if (previous.householdId !== householdId || previous.checksum !== sourceChecksum) {
          throw new ApiError('CONFLICT', '迁移批次 ID 已用于其他数据', 409);
        }
        return previous;
      }
      const summary: MigrationSummary = {
        importBatchId,
        householdId,
        batchCount: validated.summary.batchCount,
        shoppingItemCount: validated.summary.shoppingItemCount,
        cookingRecordCount: validated.summary.cookingRecordCount,
        progressCount: validated.snapshot.progress.length,
        checksum: sourceChecksum,
        status: 'prepared',
      };
      await client.query(
        `INSERT INTO v1_migrations
           (user_id, import_batch_id, household_id, checksum, summary, status, created_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, 'prepared', $6)`,
        [principal.user.id, importBatchId, householdId, sourceChecksum, JSON.stringify(summary), new Date(this.now())],
      );
      await this.audit(client, principal.user.id, householdId, 'migration.v1.prepared', importBatchId, {
        batchCount: summary.batchCount,
        shoppingItemCount: summary.shoppingItemCount,
        cookingRecordCount: summary.cookingRecordCount,
      });
      return summary;
    });
  }

  async commitV1Migration(
    accessToken: string,
    householdId: string,
    importBatchId: string,
    source: string,
  ): Promise<MigrationSummary> {
    const validated = validatedSource(source);
    const sourceChecksum = checksum(source);
    const principal = await this.queryStore.authenticate(accessToken);
    return this.transaction(async (client) => {
      await this.lock(client, `migration:${principal.user.id}:${importBatchId}`);
      await this.lock(client, `household:${householdId}`);
      await this.requireInventoryWriter(client, householdId, principal.user.id);
      const selected = await client.query<MigrationRow>(
        `SELECT user_id, import_batch_id, household_id, checksum, summary, status
         FROM v1_migrations WHERE user_id = $1 AND import_batch_id = $2 FOR UPDATE`,
        [principal.user.id, importBatchId],
      );
      if (!selected.rows[0]) throw new ApiError('VALIDATION_ERROR', '请先准备这次迁移', 400);
      const prepared = summaryFromRow(selected.rows[0]);
      if (prepared.householdId !== householdId || prepared.checksum !== sourceChecksum) {
        throw new ApiError('VALIDATION_ERROR', '迁移数据与准备阶段不一致', 400);
      }
      if (prepared.status === 'committed') return prepared;
      const occupied = await client.query<OccupiedRow>(
        `SELECT (
           EXISTS (SELECT 1 FROM pantry_batches WHERE household_id = $1) OR
           EXISTS (SELECT 1 FROM shopping_items WHERE household_id = $1) OR
           EXISTS (SELECT 1 FROM cooking_records WHERE household_id = $1)
         ) AS occupied`,
        [householdId],
      );
      if (occupied.rows[0]?.occupied) {
        throw new ApiError('CONFLICT', '目标家庭已有数据，请创建新家庭后迁移', 409);
      }
      const now = this.now();
      const changes = new PostgresMutationContext(client, householdId, this.now);
      const consumedByBatch = new Map<string, number>();
      validated.snapshot.cookingRecords.forEach((record) => record.consumptions.forEach((item) => {
        consumedByBatch.set(item.pantryBatchId, (consumedByBatch.get(item.pantryBatchId) ?? 0) + item.quantity);
      }));
      for (const batch of validated.snapshot.batches) {
        const originalQuantity = batch.quantity + (consumedByBatch.get(batch.id) ?? 0);
        if (!Number.isFinite(originalQuantity) || originalQuantity <= 0) {
          throw new ApiError('VALIDATION_ERROR', `批次 ${batch.id} 无法还原原始数量`, 400);
        }
        const serverBatch: ServerPantryBatch = {
          ...batch, householdId, originalQuantity, version: 1, createdBy: principal.user.id,
        };
        await client.query(
          `INSERT INTO pantry_batches
             (id, household_id, ingredient_id, quantity, original_quantity, unit, purchased_at, storage_mode,
              shelf_life_days_override, note, status, created_by, created_at, updated_at, version)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 1)`,
          [serverBatch.id, householdId, serverBatch.ingredientId, serverBatch.quantity, originalQuantity,
            serverBatch.unit, serverBatch.purchasedAt, serverBatch.storageMode,
            serverBatch.shelfLifeDaysOverride ?? null, serverBatch.note ?? null, serverBatch.status,
            principal.user.id, new Date(serverBatch.createdAt), new Date(serverBatch.updatedAt)],
        );
        const movement: InventoryMovement = {
          id: newId('mov'), householdId, pantryBatchId: serverBatch.id, ingredientId: serverBatch.ingredientId,
          type: 'purchase', quantityDelta: originalQuantity, unit: serverBatch.unit,
          actorUserId: principal.user.id, sourceMutationId: importBatchId, occurredAt: serverBatch.createdAt,
        };
        await this.insertMovement(client, movement);
        await changes.appendChange({ entityType: 'pantryBatch', entityId: serverBatch.id, operation: 'upsert', version: 1, payload: serverBatch });
        await changes.appendChange({ entityType: 'inventoryMovement', entityId: movement.id, operation: 'upsert', version: 1, payload: movement });
      }
      for (const record of validated.snapshot.cookingRecords) {
        // PostgreSQL enforces mutation id uniqueness per actor. A migration batch can
        // contain many cooking records, so derive one stable id for every record.
        const recordMutationId = `${importBatchId}:${record.id}`;
        const serverRecord: ServerCookingRecord = {
          ...record, householdId, actorUserId: principal.user.id, mutationId: recordMutationId, version: 1,
        };
        await client.query(
          `INSERT INTO cooking_records
             (id, household_id, recipe_id, cooked_at, servings, actor_user_id, mutation_id, version)
          VALUES ($1, $2, $3, $4, $5, $6, $7, 1)`,
          [record.id, householdId, record.recipeId, new Date(record.cookedAt), record.servings,
            principal.user.id, recordMutationId],
        );
        for (const item of record.consumptions) {
          await client.query(
            `INSERT INTO cooking_consumptions
               (cooking_record_id, household_id, pantry_batch_id, ingredient_id, quantity, unit)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [record.id, householdId, item.pantryBatchId, item.ingredientId, item.quantity, item.unit],
          );
          const movement: InventoryMovement = {
            id: newId('mov'), householdId, pantryBatchId: item.pantryBatchId, ingredientId: item.ingredientId,
            type: 'cook_consume', quantityDelta: -item.quantity, unit: item.unit,
            actorUserId: principal.user.id, sourceMutationId: importBatchId, occurredAt: record.cookedAt,
          };
          await this.insertMovement(client, movement);
          await changes.appendChange({ entityType: 'inventoryMovement', entityId: movement.id, operation: 'upsert', version: 1, payload: movement });
        }
        await changes.appendChange({ entityType: 'cookingRecord', entityId: record.id, operation: 'upsert', version: 1, payload: serverRecord });
      }
      for (const item of validated.snapshot.shoppingList) {
        const serverItem: ServerShoppingItem = {
          ...item, householdId, version: 1, createdBy: principal.user.id, updatedAt: item.createdAt,
        };
        await client.query(
          `INSERT INTO shopping_items
             (id, household_id, ingredient_id, suggested_quantity, unit, source_recipe_id, checked,
              created_by, created_at, updated_at, version)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, 1)`,
          [item.id, householdId, item.ingredientId, item.suggestedQuantity, item.unit,
            item.sourceRecipeId ?? null, item.checked, principal.user.id, new Date(item.createdAt)],
        );
        await changes.appendChange({ entityType: 'shoppingItem', entityId: item.id, operation: 'upsert', version: 1, payload: serverItem });
      }
      for (const item of validated.snapshot.progress) {
        const progress: ServerRecipeProgress = { ...item, userId: principal.user.id, householdId, version: 1 };
        await client.query(
          `INSERT INTO recipe_progress
             (household_id, user_id, recipe_id, status, unlocked_at, cook_count, last_cooked_at, version)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 1)`,
          [householdId, principal.user.id, item.recipeId, item.status,
            item.unlockedAt ? new Date(item.unlockedAt) : null, item.cookCount,
            item.lastCookedAt ? new Date(item.lastCookedAt) : null],
        );
        await changes.appendChange({
          entityType: 'recipeProgress', entityId: `${principal.user.id}:${item.recipeId}`,
          operation: 'upsert', version: 1, payload: progress,
        });
      }
      const preferences: MemberPreferences = {
        ...validated.snapshot.settings,
        favoriteRecipeIds: validated.snapshot.settings.favoriteRecipeIds ?? [],
        userId: principal.user.id,
        householdId,
        version: 1,
        updatedAt: now,
      };
      await client.query(
        `INSERT INTO member_preferences
           (household_id, user_id, freshness_reminder_days, default_storage_mode, favorite_recipe_ids, version, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, 1, $6)`,
        [householdId, principal.user.id, preferences.freshnessReminderDays, preferences.defaultStorageMode,
          JSON.stringify(preferences.favoriteRecipeIds ?? []), new Date(now)],
      );
      await changes.appendChange({ entityType: 'preferences', entityId: principal.user.id, operation: 'upsert', version: 1, payload: preferences });
      const committed: MigrationSummary = { ...prepared, status: 'committed' };
      await client.query(
        `UPDATE v1_migrations SET status = 'committed', summary = $3::jsonb, committed_at = $4
         WHERE user_id = $1 AND import_batch_id = $2`,
        [principal.user.id, importBatchId, JSON.stringify(committed), new Date(now)],
      );
      await this.audit(client, principal.user.id, householdId, 'migration.v1.committed', importBatchId, {
        cursor: await changes.currentCursor(),
        batchCount: committed.batchCount,
        shoppingItemCount: committed.shoppingItemCount,
        cookingRecordCount: committed.cookingRecordCount,
      });
      return committed;
    });
  }

  async migrationStatus(accessToken: string, importBatchId: string): Promise<MigrationSummary> {
    const principal = await this.queryStore.authenticate(accessToken);
    const result = await this.withClientQuery<MigrationRow>(
      `SELECT user_id, import_batch_id, household_id, checksum, summary, status
       FROM v1_migrations WHERE user_id = $1 AND import_batch_id = $2`,
      [principal.user.id, importBatchId],
    );
    if (!result.rows[0]) throw new ApiError('NOT_FOUND', '没有找到这次迁移', 404);
    return summaryFromRow(result.rows[0]);
  }

  private async requireInventoryWriter(client: PgClientLike, householdId: string, userId: string): Promise<void> {
    const result = await client.query<MembershipRow>(
      `SELECT role, status FROM household_members
       WHERE household_id = $1 AND user_id = $2 FOR SHARE`,
      [householdId, userId],
    );
    const member = result.rows[0];
    if (!member || member.status !== 'active') {
      throw new ApiError('MEMBERSHIP_CHANGED', '家庭成员关系已变化，不能继续迁移', 409);
    }
    if (!can(member.role, 'inventory:write')) {
      throw new ApiError('HOUSEHOLD_FORBIDDEN', '当前角色不能迁移库存', 403);
    }
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

  private async audit(
    client: PgClientLike,
    actorUserId: string,
    householdId: string,
    action: string,
    importBatchId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await client.query(
      `INSERT INTO audit_logs
         (actor_user_id, household_id, action, target_type, target_id, metadata, created_at)
       VALUES ($1, $2, $3, 'v1Migration', $4, $5::jsonb, $6)`,
      [actorUserId, householdId, action, importBatchId, JSON.stringify(metadata), new Date(this.now())],
    );
  }

  private async lock(client: PgClientLike, key: string): Promise<void> {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
  }

  private async withClientQuery<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) {
    const client = await this.pool.connect();
    try { return await client.query<R>(text, values); }
    finally { client.release(); }
  }

  private async transaction<T>(work: (client: PgClientLike) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
      await client.query("SELECT set_config('statement_timeout', $1, true)", [`${this.statementTimeoutMs}ms`]);
      await client.query("SELECT set_config('lock_timeout', $1, true)", [`${this.lockTimeoutMs}ms`]);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* 保留原始失败原因 */ }
      throw error;
    } finally {
      client.release();
    }
  }
}
