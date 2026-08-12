import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { QueryResult, QueryResultRow } from 'pg';
import { seedIngredients } from '../../miniprogram/data/ingredients.js';
import { seedRecipes } from '../../miniprogram/data/recipes.js';
import type { PgClientLike, PgPoolLike } from '../src/postgres/mutation-executor.js';
import { PostgresMigrationService } from '../src/postgres/migration-service.js';

const now = Date.parse('2026-08-13T12:00:00.000Z');
const iso = (offset = 0) => new Date(now + offset).toISOString();

function exportSource(quantity = 4): string {
  return JSON.stringify({
    ingredients: seedIngredients,
    recipes: seedRecipes,
    batches: [{
      id: 'legacy-egg', ingredientId: 'egg', quantity, unit: 'piece', purchasedAt: '2026-08-12',
      storageMode: 'chilled', status: 'active', createdAt: now - 1_000, updatedAt: now - 1_000,
    }],
    progress: [],
    cookingRecords: [],
    shoppingList: [],
    settings: { freshnessReminderDays: 3, defaultStorageMode: 'chilled', favoriteRecipeIds: [] },
    meta: { version: 3, initializedAt: now - 10_000, purchasedIngredientIds: ['egg'] },
  });
}

class FakeMigrationClient implements PgClientLike {
  readonly calls: Array<{ text: string; values: unknown[] }> = [];
  releases = 0;
  cursor = 0;
  occupied = false;
  migration: any;
  auditActions: string[] = [];
  changes: unknown[] = [];

  async query<R extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []): Promise<QueryResult<R>> {
    this.calls.push({ text, values });
    let rows: QueryResultRow[] = [];
    let rowCount = 1;
    if (text.includes("s.token_hash = decode($1, 'hex')")) {
      rows = [{
        session_id: 'session-db', user_id: 'user-db', created_at: iso(-3_000), expires_at: iso(60_000),
        last_seen_at: iso(-1_000), revoked_at: null, display_name: '小秦', user_status: 'active',
        user_created_at: iso(-20_000), user_deleted_at: null,
      }];
    } else if (text.includes('SELECT role, status FROM household_members')) {
      rows = [{ role: 'owner', status: 'active' }];
    } else if (text.includes('FROM v1_migrations')) {
      rows = this.migration ? [this.migration] : [];
      rowCount = rows.length;
    } else if (text.includes('INSERT INTO v1_migrations')) {
      this.migration = {
        user_id: values[0], import_batch_id: values[1], household_id: values[2], checksum: values[3],
        summary: JSON.parse(String(values[4])), status: 'prepared',
      };
    } else if (text.includes(') AS occupied')) {
      rows = [{ occupied: this.occupied }];
    } else if (text.includes('UPDATE household_sync_cursors') && text.includes('RETURNING current_cursor')) {
      this.cursor += 1;
      rows = [{ current_cursor: this.cursor }];
    } else if (text.includes('INSERT INTO sync_changes')) {
      this.changes.push(JSON.parse(String(values[6])));
    } else if (text.includes('SELECT current_cursor FROM household_sync_cursors')) {
      rows = [{ current_cursor: this.cursor }];
    } else if (text.includes("UPDATE v1_migrations SET status = 'committed'")) {
      this.migration = { ...this.migration, summary: JSON.parse(String(values[2])), status: 'committed' };
    } else if (text.includes('INSERT INTO audit_logs')) {
      this.auditActions.push(String(values[2]));
    }
    return { command: 'SQL', rowCount, oid: 0, fields: [], rows: rows as R[] };
  }

  release(): void { this.releases += 1; }
}

class FakePool implements PgPoolLike {
  connections = 0;
  constructor(readonly client: FakeMigrationClient) {}
  async connect(): Promise<PgClientLike> { this.connections += 1; return this.client; }
}

function service(client: FakeMigrationClient) {
  return new PostgresMigrationService(new FakePool(client), { now: () => now });
}

describe('2.0 PostgreSQL v1 显式迁移', () => {
  it('64. 预检在事务内复核库存权限，保存 checksum 与数量摘要并支持同数据幂等重放', async () => {
    const client = new FakeMigrationClient();
    const migration = service(client);
    const source = exportSource();
    const prepared = await migration.prepareV1Migration('opaque-token', 'home-db', 'import-db', source);
    const repeated = await migration.prepareV1Migration('opaque-token', 'home-db', 'import-db', source);
    assert.equal(prepared.status, 'prepared');
    assert.equal(prepared.batchCount, 1);
    assert.deepEqual(repeated, prepared);
    assert.equal(client.calls.filter((item) => item.text.includes('INSERT INTO v1_migrations')).length, 1);
    assert.ok(client.auditActions.includes('migration.v1.prepared'));
    assert.ok(client.calls.some((item) => item.text.includes('FOR SHARE')));
  });

  it('65. 确认迁移把批次、purchase 流水、偏好、三条 change 与 committed 状态原子提交', async () => {
    const client = new FakeMigrationClient();
    const migration = service(client);
    const source = exportSource();
    await migration.prepareV1Migration('opaque-token', 'home-db', 'import-db', source);
    const committed = await migration.commitV1Migration('opaque-token', 'home-db', 'import-db', source);
    assert.equal(committed.status, 'committed');
    assert.equal(client.cursor, 3);
    assert.equal(client.changes.length, 3);
    assert.ok(client.calls.some((item) => item.text.includes('INSERT INTO pantry_batches')));
    assert.ok(client.calls.some((item) => item.text.includes('INSERT INTO inventory_movements')));
    assert.ok(client.calls.some((item) => item.text.includes('INSERT INTO member_preferences')));
    assert.ok(client.calls.some((item) => item.text.includes("UPDATE v1_migrations SET status = 'committed'")));
    assert.ok(client.auditActions.includes('migration.v1.committed'));
    assert.ok(client.calls.some((item) => item.text === 'COMMIT'));
  });

  it('66. 目标家庭已有共享数据时确认迁移整体回滚，不写任何导入批次或 cursor', async () => {
    const client = new FakeMigrationClient();
    const migration = service(client);
    const source = exportSource();
    await migration.prepareV1Migration('opaque-token', 'home-db', 'import-db', source);
    client.occupied = true;
    await assert.rejects(migration.commitV1Migration('opaque-token', 'home-db', 'import-db', source), (error: any) => error?.code === 'CONFLICT');
    assert.ok(client.calls.some((item) => item.text === 'ROLLBACK'));
    assert.ok(!client.calls.some((item) => item.text.includes('INSERT INTO pantry_batches')));
    assert.ok(!client.calls.some((item) => item.text.includes('UPDATE household_sync_cursors')));
    assert.equal(client.migration.status, 'prepared');
  });
});
