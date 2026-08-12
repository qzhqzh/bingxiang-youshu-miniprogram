import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import type { Ingredient, PantryBatch, Recipe } from '../../../miniprogram/domain/models.js';
import { previewCooking } from '../../../miniprogram/domain/rules.js';
import { ApiError } from '../errors.js';
import { can } from '../rbac.js';
import type { HouseholdRole, Permission, PushResult, ServerPantryBatch, SyncEntityType } from '../types.js';

export interface PgClientLike {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
  release(): void;
}

export interface PgPoolLike {
  connect(): Promise<PgClientLike>;
}

export interface SyncChangeDraft {
  entityType: SyncEntityType;
  entityId: string;
  operation: 'upsert' | 'delete';
  version: number;
  payload: unknown;
}

export interface MutationWorkResult<T> {
  canonical: T;
  changes: SyncChangeDraft[];
}

interface MembershipRow extends QueryResultRow {
  role: HouseholdRole;
  status: string;
}

interface ProcessedRow extends QueryResultRow {
  household_id: string;
  result: PushResult | string;
}

interface CursorRow extends QueryResultRow {
  current_cursor: string | number;
}

interface BatchRow extends QueryResultRow {
  id: string;
  household_id: string;
  ingredient_id: string;
  quantity: string | number;
  original_quantity: string | number;
  unit: string;
  purchased_at: Date | string;
  storage_mode: PantryBatch['storageMode'];
  shelf_life_days_override: number | null;
  note: string | null;
  status: PantryBatch['status'];
  created_by: string;
  created_at: Date | string | number;
  updated_at: Date | string | number;
  version: string | number;
  deleted_at: Date | string | number | null;
}

function asTimestamp(value: Date | string | number): number {
  if (value instanceof Date) return value.getTime();
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error('数据库返回了无效时间');
  return parsed;
}

function asDateOnly(value: Date | string): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value.slice(0, 10);
}

function parseStoredResult(value: PushResult | string): PushResult {
  return typeof value === 'string' ? JSON.parse(value) as PushResult : value;
}

export class PostgresMutationContext {
  constructor(
    readonly client: PgClientLike,
    readonly householdId: string,
    private readonly now: () => number,
  ) {}

  async appendChange(change: SyncChangeDraft): Promise<number> {
    await this.client.query(
      `INSERT INTO household_sync_cursors (household_id, current_cursor, minimum_cursor)
       VALUES ($1, 0, 0) ON CONFLICT (household_id) DO NOTHING`,
      [this.householdId],
    );
    const allocated = await this.client.query<CursorRow>(
      `UPDATE household_sync_cursors
       SET current_cursor = current_cursor + 1
       WHERE household_id = $1
       RETURNING current_cursor`,
      [this.householdId],
    );
    const cursor = Number(allocated.rows[0]?.current_cursor);
    if (!Number.isSafeInteger(cursor) || cursor <= 0) throw new Error('无法分配家庭同步游标');
    await this.client.query(
      `INSERT INTO sync_changes
         (household_id, cursor, entity_type, entity_id, operation, version, payload, server_time)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
      [
        this.householdId,
        cursor,
        change.entityType,
        change.entityId,
        change.operation,
        change.version,
        JSON.stringify(change.payload),
        new Date(this.now()),
      ],
    );
    return cursor;
  }

  async currentCursor(): Promise<number> {
    const result = await this.client.query<CursorRow>(
      'SELECT current_cursor FROM household_sync_cursors WHERE household_id = $1',
      [this.householdId],
    );
    return Number(result.rows[0]?.current_cursor ?? 0);
  }

  async lockCookingPlan(recipe: Recipe, servings: number, ingredients: Ingredient[]) {
    const ingredientIds = [...new Set(recipe.ingredients.map((item) => item.ingredientId))].sort();
    const result = await this.client.query<BatchRow>(
      `SELECT id, household_id, ingredient_id, quantity, original_quantity, unit, purchased_at, storage_mode,
              shelf_life_days_override, note, status, created_by, created_at, updated_at, version, deleted_at
       FROM pantry_batches
       WHERE household_id = $1
         AND ingredient_id = ANY($2::text[])
         AND deleted_at IS NULL
         AND status = 'active'
         AND quantity > 0
       ORDER BY ingredient_id, id
       FOR UPDATE`,
      [this.householdId, ingredientIds],
    );
    const batches: ServerPantryBatch[] = result.rows.map((row) => ({
      id: row.id,
      householdId: row.household_id,
      ingredientId: row.ingredient_id,
      quantity: Number(row.quantity),
      originalQuantity: Number(row.original_quantity),
      unit: row.unit,
      purchasedAt: asDateOnly(row.purchased_at),
      storageMode: row.storage_mode,
      ...(row.shelf_life_days_override === null ? {} : { shelfLifeDaysOverride: row.shelf_life_days_override }),
      ...(row.note === null ? {} : { note: row.note }),
      status: row.status,
      createdBy: row.created_by,
      createdAt: asTimestamp(row.created_at),
      updatedAt: asTimestamp(row.updated_at),
      version: Number(row.version),
      ...(row.deleted_at === null ? {} : { deletedAt: asTimestamp(row.deleted_at) }),
    }));
    const preview = previewCooking(recipe, servings, batches, ingredients);
    if (!preview.canComplete) {
      throw new ApiError('INVENTORY_CONFLICT', '家庭库存不足，请按最新库存重新确认', 409, {
        missing: preview.missing,
        optionalMissing: preview.optionalMissing,
      });
    }
    return { batches, preview };
  }
}

export interface ExecuteMutationInput {
  userId: string;
  householdId: string;
  mutationId: string;
  commandName: string;
  permission: Permission;
}

export interface PostgresMutationExecutorOptions {
  statementTimeoutMs?: number;
  lockTimeoutMs?: number;
  now?: () => number;
}

/**
 * PostgreSQL 写事务边界：幂等锁、家庭串行锁、成员权限、实体写入、游标与处理结果同事务提交。
 * 领域写入由 work 回调执行；任何异常都会回滚，不留下半条 CookingRecord/流水/变更。
 */
export class PostgresMutationExecutor {
  private readonly now: () => number;
  private readonly statementTimeoutMs: number;
  private readonly lockTimeoutMs: number;

  constructor(private readonly pool: PgPoolLike, options: PostgresMutationExecutorOptions = {}) {
    this.now = options.now ?? Date.now;
    this.statementTimeoutMs = options.statementTimeoutMs ?? 8_000;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 2_000;
  }

  static fromPool(pool: Pool, options: PostgresMutationExecutorOptions = {}): PostgresMutationExecutor {
    return new PostgresMutationExecutor(pool as unknown as PgPoolLike, options);
  }

  async execute<T>(
    input: ExecuteMutationInput,
    work: (context: PostgresMutationContext) => Promise<MutationWorkResult<T>>,
  ): Promise<PushResult> {
    return this.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`mutation:${input.userId}:${input.mutationId}`]);
      const processed = await client.query<ProcessedRow>(
        `SELECT household_id, result
         FROM processed_mutations
         WHERE user_id = $1 AND mutation_id = $2
         FOR UPDATE`,
        [input.userId, input.mutationId],
      );
      if (processed.rows[0]) {
        if (processed.rows[0].household_id !== input.householdId) {
          throw new ApiError('MUTATION_REJECTED', 'mutationId 已被用于其他家庭', 409);
        }
        return { ...parseStoredResult(processed.rows[0].result), replayed: true };
      }

      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`household:${input.householdId}`]);
      const membership = await client.query<MembershipRow>(
        `SELECT role, status
         FROM household_members
         WHERE household_id = $1 AND user_id = $2
         FOR SHARE`,
        [input.householdId, input.userId],
      );
      const member = membership.rows[0];
      if (!member || member.status !== 'active') {
        throw new ApiError('MEMBERSHIP_CHANGED', '你已不在这个家庭中，离线操作不能继续提交', 403);
      }
      if (!can(member.role, input.permission)) {
        throw new ApiError('HOUSEHOLD_FORBIDDEN', '当前家庭角色没有执行此操作的权限', 403, { permission: input.permission });
      }

      const context = new PostgresMutationContext(client, input.householdId, this.now);
      const completed = await work(context);
      let cursor = await context.currentCursor();
      for (const change of completed.changes) cursor = await context.appendChange(change);
      const result: PushResult = {
        mutationId: input.mutationId,
        accepted: true,
        replayed: false,
        cursor,
        canonical: completed.canonical,
      };
      await client.query(
        `INSERT INTO processed_mutations
           (user_id, mutation_id, household_id, command_name, result, processed_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
        [input.userId, input.mutationId, input.householdId, input.commandName, JSON.stringify(result), new Date(this.now())],
      );
      return result;
    });
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

// 编译期确保原生 pg PoolClient 可满足本模块使用的最小接口。
const _poolClientCompatibility: PgClientLike | null = null as PoolClient | null;
void _poolClientCompatibility;
