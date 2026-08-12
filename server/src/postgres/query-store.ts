import type { Pool, QueryResult, QueryResultRow } from 'pg';
import { seedRecipes } from '../../../miniprogram/data/recipes.js';
import { refreshRecipeProgress } from '../../../miniprogram/domain/rules.js';
import type { AppSettings, RecipeProgress } from '../../../miniprogram/domain/models.js';
import { ApiError } from '../errors.js';
import { hashSecret } from '../security.js';
import type {
  DeviceSession,
  Household,
  HouseholdMember,
  HouseholdSnapshot,
  InventoryMovement,
  MemberPreferences,
  ServerCookingRecord,
  ServerPantryBatch,
  ServerRecipeProgress,
  ServerShoppingItem,
  SessionPrincipal,
  SyncChange,
  SyncEntityType,
  User,
} from '../types.js';
import type { PullResult } from '../api-service.js';

export interface PgQueryable {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
}

interface PrincipalRow extends QueryResultRow {
  session_id: string;
  user_id: string;
  created_at: Date | string;
  expires_at: Date | string;
  last_seen_at: Date | string;
  revoked_at: Date | string | null;
  display_name: string;
  user_status: User['status'];
  user_created_at: Date | string;
  user_deleted_at: Date | string | null;
}

interface HouseholdRow extends QueryResultRow {
  id: string;
  name: string;
  timezone: string;
  owner_user_id: string;
  status: Household['status'];
  version: string | number;
  created_at: Date | string;
  deleted_at: Date | string | null;
}

interface MemberRow extends QueryResultRow {
  household_id: string;
  user_id: string;
  role: HouseholdMember['role'];
  status: HouseholdMember['status'];
  joined_at: Date | string;
  version: string | number;
  display_name?: string;
}

interface CursorRow extends QueryResultRow {
  current_cursor: string | number;
  minimum_cursor: string | number;
}

interface ChangeRow extends QueryResultRow {
  household_id: string;
  cursor: string | number;
  entity_type: SyncEntityType;
  entity_id: string;
  operation: SyncChange['operation'];
  version: string | number;
  payload: unknown;
  server_time: Date | string;
}

interface QueryStoreOptions {
  now?: () => number;
  catalogVersion?: number;
  pullPageSize?: number;
}

const DEFAULT_SETTINGS: AppSettings = {
  freshnessReminderDays: 3,
  defaultStorageMode: 'chilled',
  favoriteRecipeIds: [],
};

function timestamp(value: Date | string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error('数据库返回了无效时间');
  return parsed;
}

function numberValue(value: string | number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('数据库返回了无效版本或游标');
  return parsed;
}

function numericValue(value: string | number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error('数据库返回了无效数值');
  return parsed;
}

function dateOnly(value: Date | string): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10);
}

function householdFromRow(row: HouseholdRow): Household {
  return {
    id: row.id,
    name: row.name,
    timezone: row.timezone,
    ownerUserId: row.owner_user_id,
    status: row.status,
    version: numberValue(row.version),
    createdAt: timestamp(row.created_at)!,
    ...(row.deleted_at ? { deletedAt: timestamp(row.deleted_at)! } : {}),
  };
}

function memberFromRow(row: MemberRow): HouseholdMember {
  return {
    householdId: row.household_id,
    userId: row.user_id,
    role: row.role,
    status: row.status,
    joinedAt: timestamp(row.joined_at)!,
    version: numberValue(row.version),
    ...(row.display_name ? { displayName: row.display_name } : {}),
  };
}

/** PostgreSQL 读模型：鉴权、租户限定 bootstrap 和增量 pull。 */
export class PostgresQueryStore {
  private readonly now: () => number;
  private readonly catalogVersion: number;
  private readonly pullPageSize: number;
  private readonly consistentRead: <T>(work: (db: PgQueryable) => Promise<T>) => Promise<T>;

  constructor(
    private readonly db: PgQueryable,
    options: QueryStoreOptions = {},
    consistentRead?: <T>(work: (db: PgQueryable) => Promise<T>) => Promise<T>,
  ) {
    this.now = options.now ?? Date.now;
    this.catalogVersion = options.catalogVersion ?? 1;
    this.pullPageSize = options.pullPageSize ?? 200;
    this.consistentRead = consistentRead ?? (async <T>(work: (db: PgQueryable) => Promise<T>) => work(db));
  }

  static fromPool(pool: Pool, options: QueryStoreOptions = {}): PostgresQueryStore {
    return new PostgresQueryStore(pool, options, async <T>(work: (db: PgQueryable) => Promise<T>) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* 保留原始失败原因 */ }
        throw error;
      } finally {
        client.release();
      }
    });
  }

  async authenticate(accessToken: string, allowDeletionPending = false): Promise<SessionPrincipal> {
    const tokenHash = hashSecret(accessToken ?? '');
    const result = await this.db.query<PrincipalRow>(
      `SELECT s.id AS session_id, s.user_id, s.created_at, s.expires_at, s.last_seen_at, s.revoked_at,
              u.display_name, u.status AS user_status, u.created_at AS user_created_at, u.deleted_at AS user_deleted_at
       FROM device_sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = decode($1, 'hex')
         AND s.revoked_at IS NULL
         AND s.expires_at > $2
         AND u.status = ANY($3::text[])
       LIMIT 1`,
      [tokenHash, new Date(this.now()), allowDeletionPending ? ['active', 'deletionPending'] : ['active']],
    );
    const row = result.rows[0];
    if (!row) throw new ApiError('UNAUTHENTICATED', '登录状态无效或已过期', 401);
    await this.db.query('UPDATE device_sessions SET last_seen_at = $2 WHERE id = $1', [row.session_id, new Date(this.now())]);
    const user: User = {
      id: row.user_id,
      displayName: row.display_name,
      status: row.user_status,
      createdAt: timestamp(row.user_created_at)!,
      ...(row.user_deleted_at ? { deletedAt: timestamp(row.user_deleted_at)! } : {}),
    };
    const session: DeviceSession = {
      id: row.session_id,
      userId: row.user_id,
      deviceIdHash: '[redacted]',
      tokenHash: '[redacted]',
      createdAt: timestamp(row.created_at)!,
      expiresAt: timestamp(row.expires_at)!,
      lastSeenAt: this.now(),
      ...(row.revoked_at ? { revokedAt: timestamp(row.revoked_at)! } : {}),
    };
    return { user, session };
  }

  async listHouseholds(userId: string): Promise<Household[]> {
    const result = await this.db.query<HouseholdRow>(
      `SELECT h.id, h.name, h.timezone, h.owner_user_id, h.status, h.version, h.created_at, h.deleted_at
       FROM households h
       JOIN household_members m ON m.household_id = h.id
       WHERE m.user_id = $1 AND m.status = 'active' AND h.status = 'active'
       ORDER BY h.created_at, h.id`,
      [userId],
    );
    return result.rows.map(householdFromRow);
  }

  async requireMember(householdId: string, userId: string, db: PgQueryable = this.db): Promise<HouseholdMember> {
    const result = await db.query<MemberRow>(
      `SELECT household_id, user_id, role, status, joined_at, version
       FROM household_members
       WHERE household_id = $1 AND user_id = $2 AND status = 'active'`,
      [householdId, userId],
    );
    const row = result.rows[0];
    if (!row) throw new ApiError('HOUSEHOLD_FORBIDDEN', '无权访问这个家庭空间', 403);
    return memberFromRow(row);
  }

  async bootstrap(householdId: string, userId: string): Promise<HouseholdSnapshot> {
    return this.consistentRead(async (db) => {
    await this.requireMember(householdId, userId, db);
    const [householdResult, membersResult, batchesResult, movementsResult, shoppingResult, cookingResult, progressResult, preferencesResult, cursorResult] = await Promise.all([
      db.query<HouseholdRow>(
        `SELECT id, name, timezone, owner_user_id, status, version, created_at, deleted_at
         FROM households WHERE id = $1 AND status = 'active'`, [householdId],
      ),
      db.query<MemberRow>(
        `SELECT m.household_id, m.user_id, m.role, m.status, m.joined_at, m.version, u.display_name
         FROM household_members m JOIN users u ON u.id = m.user_id
         WHERE m.household_id = $1 AND m.status = 'active' ORDER BY m.joined_at, m.user_id`, [householdId],
      ),
      db.query(
        `SELECT id, household_id, ingredient_id, quantity, original_quantity, unit, purchased_at, storage_mode,
                shelf_life_days_override, note, status, created_by, created_at, updated_at, version, deleted_at
         FROM pantry_batches WHERE household_id = $1 AND deleted_at IS NULL ORDER BY created_at, id`, [householdId],
      ),
      db.query(
        `SELECT id, household_id, pantry_batch_id, ingredient_id, movement_type, quantity_delta, unit,
                actor_user_id, source_mutation_id, occurred_at
         FROM inventory_movements WHERE household_id = $1 ORDER BY occurred_at, id`, [householdId],
      ),
      db.query(
        `SELECT id, household_id, ingredient_id, suggested_quantity, unit, source_recipe_id, checked,
                created_by, created_at, updated_at, version, deleted_at
         FROM shopping_items WHERE household_id = $1 AND deleted_at IS NULL ORDER BY created_at, id`, [householdId],
      ),
      db.query(
        `SELECT r.id, r.household_id, r.recipe_id, r.cooked_at, r.servings, r.actor_user_id, r.mutation_id, r.version,
                COALESCE(jsonb_agg(jsonb_build_object(
                  'pantryBatchId', c.pantry_batch_id, 'ingredientId', c.ingredient_id,
                  'quantity', c.quantity, 'unit', c.unit
                ) ORDER BY c.pantry_batch_id) FILTER (WHERE c.pantry_batch_id IS NOT NULL), '[]'::jsonb) AS consumptions
         FROM cooking_records r
         LEFT JOIN cooking_consumptions c ON c.cooking_record_id = r.id AND c.household_id = r.household_id
         WHERE r.household_id = $1
         GROUP BY r.id ORDER BY r.cooked_at, r.id`, [householdId],
      ),
      db.query(
        `SELECT household_id, user_id, recipe_id, status, unlocked_at, cook_count, last_cooked_at, version
         FROM recipe_progress WHERE household_id = $1 AND user_id = $2 ORDER BY recipe_id`, [householdId, userId],
      ),
      db.query(
        `SELECT household_id, user_id, freshness_reminder_days, default_storage_mode, favorite_recipe_ids,
                version, updated_at
         FROM member_preferences WHERE household_id = $1 AND user_id = $2`, [householdId, userId],
      ),
      db.query<CursorRow>(
        `SELECT current_cursor, minimum_cursor FROM household_sync_cursors WHERE household_id = $1`, [householdId],
      ),
    ]);
    const householdRow = householdResult.rows[0];
    if (!householdRow) throw new ApiError('NOT_FOUND', '家庭空间不存在', 404);
    const batches = batchesResult.rows.map((row: any): ServerPantryBatch => ({
      id: row.id, householdId: row.household_id, ingredientId: row.ingredient_id,
      quantity: numericValue(row.quantity), originalQuantity: numericValue(row.original_quantity), unit: row.unit,
      purchasedAt: dateOnly(row.purchased_at), storageMode: row.storage_mode,
      ...(row.shelf_life_days_override === null ? {} : { shelfLifeDaysOverride: Number(row.shelf_life_days_override) }),
      ...(row.note === null ? {} : { note: row.note }),
      status: row.status, createdBy: row.created_by, createdAt: timestamp(row.created_at)!, updatedAt: timestamp(row.updated_at)!,
      version: numberValue(row.version), ...(row.deleted_at ? { deletedAt: timestamp(row.deleted_at)! } : {}),
    }));
    const movements = movementsResult.rows.map((row: any): InventoryMovement => ({
      id: row.id, householdId: row.household_id, pantryBatchId: row.pantry_batch_id,
      ingredientId: row.ingredient_id, type: row.movement_type, quantityDelta: numericValue(row.quantity_delta),
      unit: row.unit, actorUserId: row.actor_user_id, sourceMutationId: row.source_mutation_id,
      occurredAt: timestamp(row.occurred_at)!,
    }));
    const shoppingItems = shoppingResult.rows.map((row: any): ServerShoppingItem => ({
      id: row.id, householdId: row.household_id, ingredientId: row.ingredient_id,
      suggestedQuantity: numericValue(row.suggested_quantity), unit: row.unit,
      ...(row.source_recipe_id ? { sourceRecipeId: row.source_recipe_id } : {}), checked: row.checked,
      createdBy: row.created_by, createdAt: timestamp(row.created_at)!, updatedAt: timestamp(row.updated_at)!,
      version: numberValue(row.version), ...(row.deleted_at ? { deletedAt: timestamp(row.deleted_at)! } : {}),
    }));
    const cookingRecords = cookingResult.rows.map((row: any): ServerCookingRecord => ({
      id: row.id, householdId: row.household_id, recipeId: row.recipe_id, cookedAt: timestamp(row.cooked_at)!,
      servings: numericValue(row.servings), actorUserId: row.actor_user_id, mutationId: row.mutation_id,
      version: numberValue(row.version), consumptions: Array.isArray(row.consumptions)
        ? row.consumptions.map((item: any) => ({ ...item, quantity: numericValue(item.quantity) })) : [],
    }));
    const storedProgress = progressResult.rows.map((row: any): ServerRecipeProgress => ({
      householdId: row.household_id, userId: row.user_id, recipeId: row.recipe_id, status: row.status,
      ...(row.unlocked_at ? { unlockedAt: timestamp(row.unlocked_at)! } : {}), cookCount: Number(row.cook_count),
      ...(row.last_cooked_at ? { lastCookedAt: timestamp(row.last_cooked_at)! } : {}), version: numberValue(row.version),
    }));
    const purchasedIngredientIds = [...new Set(movements.filter((item) => item.type === 'purchase').map((item) => item.ingredientId))];
    const refreshed = refreshRecipeProgress(seedRecipes, storedProgress as RecipeProgress[], purchasedIngredientIds);
    const versions = new Map(storedProgress.map((item) => [item.recipeId, item.version]));
    const recipeProgress = refreshed.map((item): ServerRecipeProgress => ({
      ...item, householdId, userId, version: versions.get(item.recipeId) ?? 0,
    }));
    const preferenceRow: any = preferencesResult.rows[0];
    const preferences: MemberPreferences = preferenceRow ? {
      householdId: preferenceRow.household_id, userId: preferenceRow.user_id,
      freshnessReminderDays: Number(preferenceRow.freshness_reminder_days),
      defaultStorageMode: preferenceRow.default_storage_mode,
      favoriteRecipeIds: Array.isArray(preferenceRow.favorite_recipe_ids) ? preferenceRow.favorite_recipe_ids : [],
      version: numberValue(preferenceRow.version), updatedAt: timestamp(preferenceRow.updated_at)!,
    } : { ...DEFAULT_SETTINGS, householdId, userId, version: 0, updatedAt: this.now() };
    return {
      household: householdFromRow(householdRow),
      members: membersResult.rows.map(memberFromRow),
      batches, movements, shoppingItems, cookingRecords, recipeProgress, preferences,
      cursor: cursorResult.rows[0] ? numberValue(cursorResult.rows[0].current_cursor) : 0,
      catalogVersion: this.catalogVersion,
    };
    });
  }

  async pull(householdId: string, userId: string, cursor: number, limit?: number): Promise<PullResult> {
    if (!Number.isInteger(cursor) || cursor < 0) throw new ApiError('VALIDATION_ERROR', '同步 cursor 无效', 400);
    return this.consistentRead(async (db) => {
    await this.requireMember(householdId, userId, db);
    const cursorResult = await db.query<CursorRow>(
      `SELECT current_cursor, minimum_cursor FROM household_sync_cursors WHERE household_id = $1`, [householdId],
    );
    const minimum = cursorResult.rows[0] ? numberValue(cursorResult.rows[0].minimum_cursor) : 0;
    if (cursor < minimum) {
      throw new ApiError('FULL_RESYNC_REQUIRED', '本地游标过旧，需要完整同步', 409, { minimumCursor: minimum });
    }
    const pageSize = Math.min(Math.max(limit ?? this.pullPageSize, 1), 500);
    const result = await db.query<ChangeRow>(
      `SELECT household_id, cursor, entity_type, entity_id, operation, version, payload, server_time
       FROM sync_changes
       WHERE household_id = $1 AND cursor > $2
       ORDER BY cursor
       LIMIT $3`,
      [householdId, cursor, pageSize + 1],
    );
    const hasMore = result.rows.length > pageSize;
    const page = result.rows.slice(0, pageSize);
    const changes: SyncChange[] = page.map((row) => ({
      householdId: row.household_id,
      cursor: numberValue(row.cursor),
      entityType: row.entity_type,
      entityId: row.entity_id,
      operation: row.operation,
      version: numberValue(row.version),
      payload: row.payload,
      serverTime: timestamp(row.server_time)!,
    }));
    return {
      changes,
      nextCursor: changes.at(-1)?.cursor ?? cursor,
      hasMore,
      catalogVersion: this.catalogVersion,
    };
    });
  }
}
