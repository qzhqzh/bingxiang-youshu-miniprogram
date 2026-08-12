import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { QueryResult, QueryResultRow } from 'pg';
import type { SyncCommand } from '../src/types.js';
import type { PgClientLike, PgPoolLike } from '../src/postgres/mutation-executor.js';
import { PostgresSyncService } from '../src/postgres/sync-service.js';

const now = Date.parse('2026-08-13T10:00:00.000Z');
const iso = (offset = 0) => new Date(now + offset).toISOString();

class FakeCommandClient implements PgClientLike {
  readonly calls: Array<{ text: string; values: unknown[] }> = [];
  readonly syncChanges: unknown[] = [];
  readonly batches = new Map<string, any>();
  shoppingRows: any[] = [];
  progressRows: any[] = [];
  purchasedRows: any[] = [];
  cursor = 2;
  releases = 0;
  processed: unknown;
  role = 'member';

  async query<R extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []): Promise<QueryResult<R>> {
    this.calls.push({ text, values });
    let rows: QueryResultRow[] = [];
    let rowCount = 1;
    if (text.includes("s.token_hash = decode($1, 'hex')")) {
      rows = [{
        session_id: 'session-db', user_id: 'user-db', created_at: iso(-2_000), expires_at: iso(60_000),
        last_seen_at: iso(-1_000), revoked_at: null, display_name: '小秦', user_status: 'active',
        user_created_at: iso(-5_000), user_deleted_at: null,
      }];
    } else if (text.includes('FROM processed_mutations')) {
      rows = [];
    } else if (text.includes('SELECT role, status') && text.includes('FROM household_members')) {
      rows = [{ role: this.role, status: 'active' }];
    } else if (text.includes('INSERT INTO pantry_batches')) {
      const row = {
        id: values[0], household_id: values[1], ingredient_id: values[2], quantity: values[3],
        original_quantity: values[3], unit: values[4], purchased_at: values[5], storage_mode: values[6],
        shelf_life_days_override: values[7], note: values[8], status: 'active', created_by: values[9],
        created_at: values[10], updated_at: values[10], version: '1', deleted_at: null,
      };
      this.batches.set(String(values[0]), row);
      rows = [row];
    } else if (text.includes('SELECT id, household_id') && text.includes('FROM shopping_items')) {
      rows = this.shoppingRows;
      rowCount = rows.length;
    } else if (text.includes('FROM member_preferences') && text.includes('FOR UPDATE')) {
      rows = [];
      rowCount = 0;
    } else if (text.includes('INSERT INTO member_preferences')) {
      rows = [{
        household_id: values[0], user_id: values[1], freshness_reminder_days: values[2],
        default_storage_mode: values[3], favorite_recipe_ids: JSON.parse(String(values[4])), version: '1', updated_at: values[5],
      }];
    } else if (text.includes('SELECT id FROM cooking_records')) {
      rows = [];
      rowCount = 0;
    } else if (text.includes('FROM recipe_progress') && text.includes('FOR UPDATE')) {
      rows = this.progressRows;
      rowCount = rows.length;
    } else if (text.includes('SELECT DISTINCT ingredient_id')) {
      rows = this.purchasedRows;
      rowCount = rows.length;
    } else if (text.includes('ingredient_id = ANY($2::text[])') && text.includes('FOR UPDATE')) {
      rows = [...this.batches.values()];
      rowCount = rows.length;
    } else if (text.includes('UPDATE pantry_batches SET quantity')) {
      const current = this.batches.get(String(values[1]));
      const row = { ...current, quantity: values[2], status: values[3], updated_at: values[4], version: String(Number(current.version) + 1) };
      this.batches.set(String(values[1]), row);
      rows = [row];
    } else if (text.includes('INSERT INTO recipe_progress')) {
      rows = [{
        household_id: values[0], user_id: values[1], recipe_id: values[2], status: values[3],
        unlocked_at: values[4], cook_count: values[5], last_cooked_at: values[6], version: '2',
      }];
    } else if (text.includes('SELECT current_cursor FROM household_sync_cursors')) {
      rows = [{ current_cursor: this.cursor }];
    } else if (text.includes('UPDATE household_sync_cursors') && text.includes('RETURNING current_cursor')) {
      this.cursor += 1;
      rows = [{ current_cursor: this.cursor }];
    } else if (text.includes('INSERT INTO sync_changes')) {
      this.syncChanges.push(JSON.parse(String(values[6])));
    } else if (text.includes('INSERT INTO processed_mutations')) {
      this.processed = JSON.parse(String(values[4]));
    }
    return { command: 'SQL', rowCount, oid: 0, fields: [], rows: rows as R[] };
  }

  release(): void { this.releases += 1; }
}

class FakePool implements PgPoolLike {
  connections = 0;
  constructor(readonly client: FakeCommandClient) {}
  async connect(): Promise<PgClientLike> { this.connections += 1; return this.client; }
}

function service(client: FakeCommandClient) {
  return new PostgresSyncService(new FakePool(client), { now: () => now, catalogVersion: 2 });
}

function base<T extends SyncCommand>(command: Omit<T, 'mutationId' | 'deviceId' | 'householdId' | 'clientOccurredAt'>): T {
  return {
    mutationId: 'mutation-db', deviceId: 'device-db', householdId: 'home-db', clientOccurredAt: iso(),
    ...command,
  } as T;
}

describe('2.0 PostgreSQL 同步命令服务', () => {
  it('56. 购入命令把批次、不可变流水、两条 change 与幂等 canonical 放在同一事务', async () => {
    const client = new FakeCommandClient();
    const command = base<Extract<SyncCommand, { command: 'PurchaseBatch' }>>({
      command: 'PurchaseBatch', entityId: 'batch-db', baseVersion: 0,
      payload: { ingredientId: 'egg', quantity: 6, unit: 'piece', purchasedAt: '2026-08-13', storageMode: 'chilled' },
    });
    const result = await service(client).push('opaque-token', command);
    assert.equal((result.canonical as any).quantity, 6);
    assert.equal(result.cursor, 4);
    assert.equal(client.syncChanges.length, 2);
    assert.equal((client.processed as any).canonical.id, 'batch-db');
    assert.ok(client.calls.some((item) => item.text.includes('INSERT INTO inventory_movements')));
    assert.ok(client.calls.some((item) => item.text === 'COMMIT'));
    assert.ok(!client.calls.some((item) => item.text === 'ROLLBACK'));
    assert.equal(client.releases, 3);
  });

  it('57. 购物项 baseVersion 冲突返回服务端值并回滚，不分配 cursor 或保存幂等结果', async () => {
    const client = new FakeCommandClient();
    client.shoppingRows = [{
      id: 'shop-db', household_id: 'home-db', ingredient_id: 'egg', suggested_quantity: '6', unit: 'piece',
      source_recipe_id: null, checked: false, created_by: 'user-db', created_at: iso(-2_000),
      updated_at: iso(-1_000), version: '2', deleted_at: null,
    }];
    const command = base<Extract<SyncCommand, { command: 'CheckShoppingItem' }>>({
      command: 'CheckShoppingItem', entityId: 'shop-db', baseVersion: 1, payload: { checked: true },
    });
    await assert.rejects(service(client).push('opaque-token', command), (error: any) => {
      assert.equal(error?.code, 'VERSION_CONFLICT');
      assert.equal(error?.details?.serverValue?.version, 2);
      return true;
    });
    assert.ok(client.calls.some((item) => item.text === 'ROLLBACK'));
    assert.ok(!client.calls.some((item) => item.text.includes('UPDATE household_sync_cursors')));
    assert.equal(client.processed, undefined);
  });

  it('58. 个人偏好首次写入从 version 0 原子 upsert，并只同步当前用户实体', async () => {
    const client = new FakeCommandClient();
    client.role = 'viewer';
    const command = base<Extract<SyncCommand, { command: 'UpdatePreferences' }>>({
      command: 'UpdatePreferences', entityId: 'user-db', baseVersion: 0,
      payload: { freshnessReminderDays: 5, defaultStorageMode: 'room', favoriteRecipeIds: ['steamed_egg'] },
    });
    const result = await service(client).push('opaque-token', command);
    assert.equal((result.canonical as any).version, 1);
    assert.equal((result.canonical as any).freshnessReminderDays, 5);
    assert.equal(client.syncChanges.length, 1);
    assert.equal((client.syncChanges[0] as any).userId, 'user-db');
    assert.ok(client.calls.some((item) => item.text.includes('ON CONFLICT (household_id, user_id) DO UPDATE')));
  });

  it('59. 做菜命令锁定候选批次，按 FEFO 扣减并原子保存流水、consumption、记录和进度', async () => {
    const client = new FakeCommandClient();
    client.role = 'member';
    client.progressRows = [{
      household_id: 'home-db', user_id: 'user-db', recipe_id: 'steamed_egg', status: 'mastered',
      unlocked_at: iso(-10_000), cook_count: 0, last_cooked_at: null, version: '1',
    }];
    client.batches.set('egg-db', {
      id: 'egg-db', household_id: 'home-db', ingredient_id: 'egg', quantity: '2', original_quantity: '2',
      unit: 'piece', purchased_at: '2026-08-10', storage_mode: 'chilled', shelf_life_days_override: null,
      note: null, status: 'active', created_by: 'user-db', created_at: iso(-5_000), updated_at: iso(-5_000),
      version: '1', deleted_at: null,
    });
    client.batches.set('salt-db', {
      id: 'salt-db', household_id: 'home-db', ingredient_id: 'salt', quantity: '1', original_quantity: '1',
      unit: 'g', purchased_at: '2026-08-01', storage_mode: 'room', shelf_life_days_override: null,
      note: null, status: 'active', created_by: 'user-db', created_at: iso(-6_000), updated_at: iso(-6_000),
      version: '1', deleted_at: null,
    });
    const command = base<Extract<SyncCommand, { command: 'CompleteCooking' }>>({
      command: 'CompleteCooking', entityId: 'cook-db', baseVersion: 0,
      payload: { recipeId: 'steamed_egg', servings: 1 },
    });
    const result = await service(client).push('opaque-token', command);
    assert.equal((result.canonical as any).consumptions.length, 2);
    assert.equal(client.batches.get('egg-db').quantity, 0);
    assert.equal(client.batches.get('salt-db').quantity, 0);
    assert.equal(client.syncChanges.length, 6);
    assert.equal(result.cursor, 8);
    assert.equal(client.calls.filter((item) => item.text.includes('INSERT INTO inventory_movements')).length, 2);
    assert.equal(client.calls.filter((item) => item.text.includes('INSERT INTO cooking_consumptions')).length, 2);
    assert.ok(client.calls.some((item) => item.text.includes('INSERT INTO cooking_records')));
    assert.ok(client.calls.some((item) => item.text.includes('ingredient_id = ANY($2::text[])') && item.text.includes('FOR UPDATE')));
    assert.ok(client.calls.some((item) => item.text === 'COMMIT'));
  });
});
