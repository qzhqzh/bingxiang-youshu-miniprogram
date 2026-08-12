import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { QueryResult, QueryResultRow } from 'pg';
import type { Ingredient, Recipe } from '../../miniprogram/domain/models.js';
import { ApiError } from '../src/errors.js';
import {
  PostgresMutationExecutor,
  type PgClientLike,
  type PgPoolLike,
} from '../src/postgres/mutation-executor.js';
import type { PushResult } from '../src/types.js';

function result<R extends QueryResultRow>(rows: R[]): QueryResult<R> {
  return { command: '', rowCount: rows.length, oid: 0, fields: [], rows };
}

class FakePgClient implements PgClientLike {
  readonly queries: Array<{ text: string; values: unknown[] }> = [];
  readonly syncChanges: unknown[][] = [];
  released = false;
  cursor = 0;
  membership: QueryResultRow | undefined = { role: 'member', status: 'active' };
  processed: { household_id: string; result: PushResult } | undefined;
  batches: QueryResultRow[] = [];

  async query<R extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []): Promise<QueryResult<R>> {
    const normalized = text.replace(/\s+/g, ' ').trim();
    this.queries.push({ text: normalized, values });
    if (normalized.startsWith('SELECT household_id, result FROM processed_mutations')) {
      return result((this.processed ? [this.processed] : []) as unknown as R[]);
    }
    if (normalized.startsWith('SELECT role, status FROM household_members')) {
      return result((this.membership ? [this.membership] : []) as R[]);
    }
    if (normalized.startsWith('SELECT current_cursor FROM household_sync_cursors')) {
      return result((this.cursor ? [{ current_cursor: this.cursor }] : []) as unknown as R[]);
    }
    if (normalized.startsWith('UPDATE household_sync_cursors')) {
      this.cursor += 1;
      return result([{ current_cursor: this.cursor }] as unknown as R[]);
    }
    if (normalized.startsWith('INSERT INTO sync_changes')) {
      this.syncChanges.push(values);
      return result([] as R[]);
    }
    if (normalized.startsWith('INSERT INTO processed_mutations')) {
      this.processed = { household_id: String(values[2]), result: JSON.parse(String(values[4])) as PushResult };
      return result([] as R[]);
    }
    if (normalized.includes('FROM pantry_batches')) return result(this.batches as R[]);
    if (
      normalized === 'BEGIN'
      || normalized === 'COMMIT'
      || normalized === 'ROLLBACK'
      || normalized.startsWith('SET TRANSACTION')
      || normalized.startsWith('SELECT set_config')
      || normalized.startsWith('SELECT pg_advisory_xact_lock')
      || normalized.startsWith('INSERT INTO household_sync_cursors')
    ) return result([] as R[]);
    throw new Error(`测试未处理 SQL：${normalized}`);
  }

  release(): void { this.released = true; }
}

class FakePgPool implements PgPoolLike {
  constructor(readonly client: FakePgClient) {}
  async connect(): Promise<PgClientLike> { return this.client; }
}

function executor(client: FakePgClient): PostgresMutationExecutor {
  return new PostgresMutationExecutor(new FakePgPool(client), { now: () => 1_800_000_000_000 });
}

const mutationInput = {
  userId: 'user-1', householdId: 'home', mutationId: 'mutation-1', commandName: 'PurchaseBatch', permission: 'inventory:write' as const,
};

describe('2.0 PostgreSQL 事务执行器', () => {
  it('33. 实体变更、单调 cursor 与幂等结果在同一个 SERIALIZABLE 事务提交', async () => {
    const client = new FakePgClient();
    const response = await executor(client).execute(mutationInput, async () => ({
      canonical: { id: 'batch-1', quantity: 2 },
      changes: [
        { entityType: 'pantryBatch', entityId: 'batch-1', operation: 'upsert', version: 1, payload: { quantity: 2 } },
        { entityType: 'inventoryMovement', entityId: 'move-1', operation: 'upsert', version: 1, payload: { quantityDelta: 2 } },
      ],
    }));
    assert.equal(response.cursor, 2);
    assert.equal(response.replayed, false);
    assert.equal(client.syncChanges.length, 2);
    assert.equal(client.processed?.result.cursor, 2);
    assert.ok(client.queries.some((item) => item.text === 'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE'));
    assert.ok(client.queries.some((item) => item.text === 'COMMIT'));
    assert.ok(!client.queries.some((item) => item.text === 'ROLLBACK'));
    assert.equal(client.released, true);
  });

  it('34. 相同 mutationId 返回第一次结果且不再执行领域写入', async () => {
    const client = new FakePgClient();
    client.processed = {
      household_id: 'home',
      result: { mutationId: 'mutation-1', accepted: true, replayed: false, cursor: 9, canonical: { id: 'existing' } },
    };
    let workCalls = 0;
    const response = await executor(client).execute(mutationInput, async () => {
      workCalls += 1;
      return { canonical: {}, changes: [] };
    });
    assert.equal(workCalls, 0);
    assert.equal(response.cursor, 9);
    assert.equal(response.replayed, true);
    assert.equal(client.syncChanges.length, 0);
    assert.ok(client.queries.some((item) => item.text === 'COMMIT'));
  });

  it('35. 任一领域写入失败会 ROLLBACK 且不保存 processed_mutations', async () => {
    const client = new FakePgClient();
    await assert.rejects(
      executor(client).execute(mutationInput, async () => { throw new ApiError('INVENTORY_CONFLICT', '库存不足', 409); }),
      (error: unknown) => error instanceof ApiError && error.code === 'INVENTORY_CONFLICT',
    );
    assert.equal(client.processed, undefined);
    assert.ok(client.queries.some((item) => item.text === 'ROLLBACK'));
    assert.ok(!client.queries.some((item) => item.text === 'COMMIT'));
    assert.equal(client.released, true);
  });

  it('36. 做菜候选批次先 FOR UPDATE，再复用纯 TypeScript FEFO 按到期日分配', async () => {
    const client = new FakePgClient();
    client.batches = [
      {
        id: 'frozen-old', household_id: 'home', ingredient_id: 'egg', quantity: '2', original_quantity: '2', unit: 'piece', purchased_at: '2026-08-01',
        storage_mode: 'frozen', shelf_life_days_override: null, note: null, status: 'active',
        created_by: 'user', created_at: '2026-08-01T01:00:00.000Z', updated_at: '2026-08-01T01:00:00.000Z', version: '1', deleted_at: null,
      },
      {
        id: 'room-new', household_id: 'home', ingredient_id: 'egg', quantity: '2', original_quantity: '2', unit: 'piece', purchased_at: '2026-08-10',
        storage_mode: 'room', shelf_life_days_override: null, note: null, status: 'active',
        created_by: 'user', created_at: '2026-08-10T01:00:00.000Z', updated_at: '2026-08-10T01:00:00.000Z', version: '1', deleted_at: null,
      },
    ];
    const ingredient: Ingredient = {
      id: 'egg', name: '鸡蛋', category: 'eggDairy', defaultUnit: 'piece', icon: '',
      shelfLifeDays: { room: 3, chilled: 14, frozen: 30 },
    };
    const recipe: Recipe = {
      id: 'egg-test', name: '测试鸡蛋', description: '', difficulty: 1, durationMin: 5, servings: 1,
      ingredients: [{ ingredientId: 'egg', amount: 3, unit: 'piece' }], steps: [], cautions: [], unlockRule: { type: 'starter' }, tags: [],
    };
    const response = await executor(client).execute(
      { ...mutationInput, commandName: 'CompleteCooking', permission: 'cooking:write' },
      async (context) => {
        const plan = await context.lockCookingPlan(recipe, 1, [ingredient]);
        return { canonical: plan.preview, changes: [] };
      },
    );
    const canonical = response.canonical as { allocations: Array<{ pantryBatchId: string; quantity: number }> };
    assert.deepEqual(canonical.allocations.map((item) => [item.pantryBatchId, item.quantity]), [['room-new', 2], ['frozen-old', 1]]);
    assert.ok(client.queries.some((item) => item.text.includes('FROM pantry_batches') && item.text.endsWith('FOR UPDATE')));
  });
});
