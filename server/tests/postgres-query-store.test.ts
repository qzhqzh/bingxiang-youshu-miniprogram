import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { QueryResult, QueryResultRow } from 'pg';
import { PostgresQueryStore, type PgQueryable } from '../src/postgres/query-store.js';
import { hashSecret } from '../src/security.js';

interface Script {
  includes: string;
  rows: QueryResultRow[];
}

class ScriptedDb implements PgQueryable {
  readonly calls: Array<{ text: string; values: unknown[] }> = [];
  constructor(private readonly scripts: Script[]) {}

  async query<R extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []): Promise<QueryResult<R>> {
    this.calls.push({ text, values });
    const script = this.scripts.shift();
    assert.ok(script, `没有为 SQL 准备结果：${text}`);
    assert.ok(text.includes(script.includes), `SQL 未包含预期片段：${script.includes}`);
    const rows = script.rows as R[];
    return { command: 'SELECT', rowCount: rows.length, oid: 0, fields: [], rows };
  }

  done(): void { assert.equal(this.scripts.length, 0, '仍有未使用的数据库脚本结果'); }
}

const now = Date.parse('2026-08-13T08:00:00.000Z');
const iso = (offset = 0) => new Date(now + offset).toISOString();
const activeMember = {
  household_id: 'home', user_id: 'alice', role: 'owner', status: 'active', joined_at: iso(-10_000), version: '1',
};

describe('2.0 PostgreSQL 读模型', () => {
  it('45. 会话鉴权只用 token 哈希查询，并返回脱敏 principal', async () => {
    const db = new ScriptedDb([
      { includes: "s.token_hash = decode($1, 'hex')", rows: [{
        session_id: 'session-1', user_id: 'alice', created_at: iso(-1_000), expires_at: iso(60_000),
        last_seen_at: iso(-500), revoked_at: null, display_name: '小秦', user_status: 'active',
        user_created_at: iso(-10_000), user_deleted_at: null,
      }] },
      { includes: 'UPDATE device_sessions SET last_seen_at', rows: [] },
      { includes: 'JOIN household_members m', rows: [{
        id: 'home', name: '我的冰箱', timezone: 'Asia/Shanghai', owner_user_id: 'alice', status: 'active',
        version: '2', created_at: iso(-10_000), deleted_at: null,
      }] },
    ]);
    const store = new PostgresQueryStore(db, { now: () => now });
    const token = 'very-secret-access-token';
    const principal = await store.authenticate(token);
    const households = await store.listHouseholds(principal.user.id);
    assert.equal(principal.user.displayName, '小秦');
    assert.equal(principal.session.tokenHash, '[redacted]');
    assert.equal(principal.session.deviceIdHash, '[redacted]');
    assert.equal(households[0]?.id, 'home');
    assert.equal(db.calls[0]?.values[0], hashSecret(token));
    assert.ok(!JSON.stringify(db.calls).includes(token));
    assert.deepEqual(db.calls[0]?.values[2], ['active']);
    db.done();
  });

  it('46. bootstrap 的每张家庭事实表都带 household 条件，个人进度按 user 隔离', async () => {
    const db = new ScriptedDb([
      { includes: 'FROM household_members', rows: [activeMember] },
      { includes: "FROM households WHERE id = $1 AND status = 'active'", rows: [{
        id: 'home', name: '我的冰箱', timezone: 'Asia/Shanghai', owner_user_id: 'alice', status: 'active',
        version: 1, created_at: iso(-20_000), deleted_at: null,
      }] },
      { includes: 'FROM household_members m JOIN users', rows: [{ ...activeMember, display_name: '小秦' }] },
      { includes: 'FROM pantry_batches WHERE household_id = $1', rows: [{
        id: 'batch-1', household_id: 'home', ingredient_id: 'egg', quantity: '2.000', original_quantity: '3.000',
        unit: '枚', purchased_at: '2026-08-12', storage_mode: 'chilled', shelf_life_days_override: null,
        note: null, status: 'active', created_by: 'alice', created_at: iso(-8_000), updated_at: iso(-2_000),
        version: '2', deleted_at: null,
      }] },
      { includes: 'FROM inventory_movements WHERE household_id = $1', rows: [{
        id: 'move-1', household_id: 'home', pantry_batch_id: 'batch-1', ingredient_id: 'egg',
        movement_type: 'purchase', quantity_delta: '3.000', unit: '枚', actor_user_id: 'alice',
        source_mutation_id: 'mutation-1', occurred_at: iso(-8_000),
      }] },
      { includes: 'FROM shopping_items WHERE household_id = $1', rows: [] },
      { includes: 'FROM cooking_records r', rows: [{
        id: 'cook-1', household_id: 'home', recipe_id: 'steamed_egg', cooked_at: iso(-1_000), servings: '1.00',
        actor_user_id: 'alice', mutation_id: 'mutation-cook', version: 1,
        consumptions: [{ pantryBatchId: 'batch-1', ingredientId: 'egg', quantity: '1.000', unit: '枚' }],
      }] },
      { includes: 'FROM recipe_progress WHERE household_id = $1 AND user_id = $2', rows: [] },
      { includes: 'FROM member_preferences WHERE household_id = $1 AND user_id = $2', rows: [] },
      { includes: 'FROM household_sync_cursors WHERE household_id = $1', rows: [{ current_cursor: '9', minimum_cursor: '0' }] },
    ]);
    const store = new PostgresQueryStore(db, { now: () => now, catalogVersion: 7 });
    const snapshot = await store.bootstrap('home', 'alice');
    assert.equal(snapshot.household.id, 'home');
    assert.equal(snapshot.batches[0]?.quantity, 2);
    assert.equal(snapshot.movements[0]?.quantityDelta, 3);
    assert.equal(snapshot.cookingRecords[0]?.consumptions[0]?.quantity, 1);
    assert.ok(snapshot.recipeProgress.every((item) => item.userId === 'alice' && item.householdId === 'home'));
    assert.equal(snapshot.preferences.version, 0);
    assert.equal(snapshot.cursor, 9);
    assert.equal(snapshot.catalogVersion, 7);
    for (const call of db.calls.slice(1)) assert.equal(call.values[0], 'home');
    assert.deepEqual(db.calls[7]?.values, ['home', 'alice']);
    assert.deepEqual(db.calls[8]?.values, ['home', 'alice']);
    db.done();
  });

  it('47. pull 使用最小 cursor 触发全量重同步，并以 limit+1 判断下一页', async () => {
    const staleDb = new ScriptedDb([
      { includes: 'FROM household_members', rows: [activeMember] },
      { includes: 'FROM household_sync_cursors', rows: [{ current_cursor: 10, minimum_cursor: 5 }] },
    ]);
    const stale = new PostgresQueryStore(staleDb);
    await assert.rejects(
      stale.pull('home', 'alice', 4),
      (error: any) => error?.code === 'FULL_RESYNC_REQUIRED' && error?.details?.minimumCursor === 5,
    );

    const pageDb = new ScriptedDb([
      { includes: 'FROM household_members', rows: [activeMember] },
      { includes: 'FROM household_sync_cursors', rows: [{ current_cursor: 10, minimum_cursor: 0 }] },
      { includes: 'FROM sync_changes', rows: [1, 2, 3].map((cursor) => ({
        household_id: 'home', cursor, entity_type: 'shoppingItem', entity_id: `item-${cursor}`,
        operation: 'upsert', version: 1, payload: { id: `item-${cursor}` }, server_time: iso(cursor),
      })) },
    ]);
    const store = new PostgresQueryStore(pageDb, { catalogVersion: 4 });
    const page = await store.pull('home', 'alice', 0, 2);
    assert.equal(page.changes.length, 2);
    assert.equal(page.nextCursor, 2);
    assert.equal(page.hasMore, true);
    assert.equal(page.catalogVersion, 4);
    assert.deepEqual(pageDb.calls[2]?.values, ['home', 0, 3]);
    pageDb.done();
  });

  it('48. Pool 模式的 pull 在单连接 REPEATABLE READ READ ONLY 快照中提交', async () => {
    const calls: string[] = [];
    let released = false;
    const scripts: Script[] = [
      { includes: 'FROM household_members', rows: [activeMember] },
      { includes: 'FROM household_sync_cursors', rows: [{ current_cursor: 0, minimum_cursor: 0 }] },
      { includes: 'FROM sync_changes', rows: [] },
    ];
    const client = {
      async query<R extends QueryResultRow = QueryResultRow>(text: string): Promise<QueryResult<R>> {
        calls.push(text);
        if (text === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' || text === 'COMMIT' || text === 'ROLLBACK') {
          return { command: text, rowCount: 0, oid: 0, fields: [], rows: [] };
        }
        const script = scripts.shift();
        assert.ok(script);
        assert.ok(text.includes(script.includes));
        return { command: 'SELECT', rowCount: script.rows.length, oid: 0, fields: [], rows: script.rows as R[] };
      },
      release() { released = true; },
    };
    const pool = { async connect() { return client; } };
    const store = PostgresQueryStore.fromPool(pool);
    const page = await store.pull('home', 'alice', 0, 20);
    assert.equal(page.hasMore, false);
    assert.equal(calls[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    assert.equal(calls.at(-1), 'COMMIT');
    assert.ok(!calls.includes('ROLLBACK'));
    assert.equal(released, true);
    assert.equal(scripts.length, 0);
  });
});
