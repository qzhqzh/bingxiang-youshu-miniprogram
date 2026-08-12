import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { QueryResult, QueryResultRow } from 'pg';
import type { PgClientLike, PgPoolLike } from '../src/postgres/mutation-executor.js';
import { PostgresPrivacyService } from '../src/postgres/privacy-service.js';

const now = Date.parse('2026-08-13T11:00:00.000Z');
const iso = (offset = 0) => new Date(now + offset).toISOString();
const householdRow = {
  id: 'home-db', name: '共享厨房', timezone: 'Asia/Shanghai', owner_user_id: 'owner-other', status: 'active',
  version: '1', created_at: iso(-10_000), deleted_at: null,
};
const memberRow = {
  household_id: 'home-db', user_id: 'user-db', role: 'member', status: 'active', joined_at: iso(-9_000),
  version: '1', display_name: '小秦',
};

class FakePrivacyClient implements PgClientLike {
  readonly calls: Array<{ text: string; values: unknown[] }> = [];
  releases = 0;
  userStatus = 'active';
  householdRows: any[] = [];
  members: any[] = [memberRow];
  ownedRows: any[] = [];
  existingPendingRows: any[] = [];
  latestRows: any[] = [];
  dueRows: any[] = [];
  activeMembershipRows: any[] = [];
  cursor = 0;
  exportPayload: unknown;
  auditActions: string[] = [];

  async query<R extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []): Promise<QueryResult<R>> {
    this.calls.push({ text, values });
    let rows: QueryResultRow[] = [];
    let rowCount = 1;
    if (text.includes("s.token_hash = decode($1, 'hex')")) {
      rows = [{
        session_id: 'session-db', user_id: 'user-db', created_at: iso(-3_000), expires_at: iso(60_000),
        last_seen_at: iso(-1_000), revoked_at: null, display_name: '小秦', user_status: this.userStatus,
        user_created_at: iso(-20_000), user_deleted_at: null,
      }];
    } else if (text.includes('FROM households h') && text.includes('JOIN household_members m')) {
      rows = this.householdRows;
    } else if (text.includes('SELECT id, user_id, created_at, expires_at, last_seen_at, revoked_at')) {
      rows = [{ id: 'session-db', user_id: 'user-db', created_at: iso(-3_000), expires_at: iso(60_000), last_seen_at: iso(), revoked_at: null }];
    } else if (text.includes('FROM household_members') && text.includes("household_id = $1 AND user_id = $2 AND status = 'active'")) {
      rows = this.members.slice(0, 1);
    } else if (text.includes("FROM households WHERE id = $1 AND status = 'active'")) {
      rows = this.householdRows.slice(0, 1);
    } else if (text.includes('FROM household_members m JOIN users u')) {
      rows = this.members;
    } else if (text.includes('FROM pantry_batches')) {
      rows = [];
      rowCount = 0;
    } else if (text.includes('FROM inventory_movements')) {
      rows = [];
      rowCount = 0;
    } else if (text.includes('FROM shopping_items')) {
      rows = [];
      rowCount = 0;
    } else if (text.includes('FROM cooking_records')) {
      rows = [];
      rowCount = 0;
    } else if (text.includes('FROM recipe_progress')) {
      rows = [];
      rowCount = 0;
    } else if (text.includes('FROM member_preferences')) {
      rows = [];
      rowCount = 0;
    } else if (text.includes('SELECT current_cursor, minimum_cursor')) {
      rows = [{ current_cursor: this.cursor, minimum_cursor: 0 }];
    } else if (text.includes('INSERT INTO data_export_jobs')) {
      this.exportPayload = JSON.parse(String(values[3]));
    } else if (text.includes('INSERT INTO audit_logs')) {
      this.auditActions.push(String(values[1]));
    } else if (text.includes("status = 'pending' FOR UPDATE")) {
      rows = this.existingPendingRows;
      rowCount = rows.length;
    } else if (text.includes('SELECT id FROM households') && text.includes('owner_user_id')) {
      rows = this.ownedRows;
      rowCount = rows.length;
    } else if (text.includes('ORDER BY requested_at DESC LIMIT 1 FOR UPDATE')) {
      rows = this.latestRows;
      rowCount = rows.length;
    } else if (text.includes('ORDER BY requested_at DESC LIMIT 1')) {
      rows = this.latestRows;
      rowCount = rows.length;
    } else if (text.includes("SET status = 'cancelled'")) {
      const row: any = this.latestRows[0];
      rows = [{ ...row, status: 'cancelled', cancelled_at: values[1] }];
    } else if (text.includes('execute_after <= $1')) {
      rows = this.dueRows;
      rowCount = rows.length;
    } else if (text.includes("WHERE user_id = $1 AND status = 'active' ORDER BY household_id FOR UPDATE")) {
      rows = this.activeMembershipRows;
      rowCount = rows.length;
    } else if (text.includes("SET status = 'removed'")) {
      const row: any = this.activeMembershipRows.find((item) => item.household_id === values[0]);
      rows = [{ ...row, status: 'removed', version: String(Number(row.version) + 1) }];
    } else if (text.includes('UPDATE household_sync_cursors') && text.includes('RETURNING current_cursor')) {
      this.cursor += 1;
      rows = [{ current_cursor: this.cursor }];
    } else if (text.includes("SET status = 'completed'")) {
      const row: any = this.dueRows.find((item) => item.id === values[0]);
      rows = [{ ...row, status: 'completed', completed_at: values[1] }];
    } else if (text.includes("SET status = 'blocked'")) {
      const row: any = this.dueRows.find((item) => item.id === values[0]);
      rows = [{ ...row, status: 'blocked', blocked_reason: 'OWNED_HOUSEHOLD_REMAINS' }];
    }
    return { command: 'SQL', rowCount, oid: 0, fields: [], rows: rows as R[] };
  }

  release(): void { this.releases += 1; }
}

class FakePool implements PgPoolLike {
  connections = 0;
  constructor(readonly client: FakePrivacyClient) {}
  async connect(): Promise<PgClientLike> { this.connections += 1; return this.client; }
}

function service(client: FakePrivacyClient) {
  return new PostgresPrivacyService(new FakePool(client), {
    now: () => now, dataExportTtlMs: 60_000, deletionCoolingMs: 7 * 24 * 60 * 60 * 1_000,
  });
}

function deletionRow(status = 'pending') {
  return {
    id: 'delete-db', user_id: 'user-db', status, restricted_session_id: 'session-db', requested_at: iso(),
    execute_after: iso(7 * 24 * 60 * 60 * 1_000), cancelled_at: null, completed_at: null, blocked_reason: null,
  };
}

describe('2.0 PostgreSQL 数据权利', () => {
  it('60. 数据导出只组装可读家庭与本人状态，落库负载和响应均不含会话密钥字段', async () => {
    const client = new FakePrivacyClient();
    client.householdRows = [householdRow];
    const artifact = await service(client).createDataExport('opaque-token');
    assert.equal(artifact.payload.households[0]?.scope, 'member-readable');
    assert.equal(artifact.payload.households[0]?.membership.userId, 'user-db');
    const serialized = JSON.stringify({ artifact, persisted: client.exportPayload });
    assert.ok(!serialized.includes('tokenHash'));
    assert.ok(!serialized.includes('deviceIdHash'));
    assert.ok(!serialized.includes('opaque-token'));
    assert.ok(client.auditActions.includes('user.export.created'));
    assert.ok(client.calls.some((item) => item.text.includes('INSERT INTO data_export_jobs')));
  });

  it('61. 注销申请在事务内重新检查 owner，仍拥有家庭时回滚且不改变用户状态', async () => {
    const client = new FakePrivacyClient();
    client.ownedRows = [{ id: 'owned-home' }];
    await assert.rejects(service(client).requestAccountDeletion('opaque-token', '注销账号'), (error: any) => {
      assert.equal(error?.code, 'CONFLICT');
      assert.deepEqual(error?.details?.ownedHouseholdIds, ['owned-home']);
      return true;
    });
    assert.ok(client.calls.some((item) => item.text === 'ROLLBACK'));
    assert.ok(!client.calls.some((item) => item.text.includes("UPDATE users SET status = 'deletionPending'")));
  });

  it('62. 注销申请保留并延长当前受限会话、撤销其他会话，冷静期内可原子取消', async () => {
    const client = new FakePrivacyClient();
    const privacy = service(client);
    const request = await privacy.requestAccountDeletion('opaque-token', '注销账号');
    assert.equal(request.status, 'pending');
    assert.ok(client.calls.some((item) => item.text.includes('GREATEST(expires_at, $4)')));
    assert.ok(client.auditActions.includes('user.deletion.requested'));
    client.userStatus = 'deletionPending';
    client.latestRows = [deletionRow()];
    const cancelled = await privacy.cancelAccountDeletion('opaque-token');
    assert.equal(cancelled.status, 'cancelled');
    assert.ok(client.calls.some((item) => item.text.includes("UPDATE users SET status = 'active'")));
    assert.ok(client.auditActions.includes('user.deletion.cancelled'));
  });

  it('63. 到期 worker 使用 SKIP LOCKED，移除成员个人状态并匿名化用户但不删除共享做菜事实', async () => {
    const client = new FakePrivacyClient();
    client.dueRows = [{ ...deletionRow(), execute_after: iso(-1) }];
    client.activeMembershipRows = [memberRow];
    const [completed] = await service(client).executeDueAccountDeletions(now);
    assert.equal(completed?.status, 'completed');
    assert.ok(client.calls.some((item) => item.text.includes('FOR UPDATE SKIP LOCKED')));
    assert.ok(client.calls.some((item) => item.text.includes('DELETE FROM auth_identities')));
    assert.ok(client.calls.some((item) => item.text.includes('DELETE FROM member_preferences')));
    assert.ok(client.calls.some((item) => item.text.includes('DELETE FROM recipe_progress')));
    assert.ok(client.calls.some((item) => item.text.includes("display_name = '已注销成员'")));
    assert.ok(!client.calls.some((item) => item.text.includes('DELETE FROM cooking_records')));
    assert.equal(client.cursor, 1);
    assert.ok(client.auditActions.includes('user.deletion.completed'));
  });
});
