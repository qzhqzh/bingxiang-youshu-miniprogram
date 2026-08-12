import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { QueryResult, QueryResultRow } from 'pg';
import { PostgresHouseholdService } from '../src/postgres/household-service.js';
import type { PgClientLike, PgPoolLike } from '../src/postgres/mutation-executor.js';

interface SqlStep {
  includes: string;
  rows?: QueryResultRow[];
  rowCount?: number;
}

class ScriptedPool implements PgPoolLike {
  readonly calls: Array<{ text: string; values: unknown[] }> = [];
  connections = 0;
  releases = 0;

  constructor(private readonly steps: SqlStep[]) {}

  async connect(): Promise<PgClientLike> {
    this.connections += 1;
    return {
      query: async <R extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []) => {
        this.calls.push({ text, values });
        const step = this.steps.shift();
        assert.ok(step, `没有为 SQL 准备脚本：${text}`);
        assert.ok(text.includes(step.includes), `SQL 未包含预期片段：${step.includes}\n实际：${text}`);
        const rows = (step.rows ?? []) as R[];
        return { command: 'SQL', rowCount: step.rowCount ?? rows.length, oid: 0, fields: [], rows } as QueryResult<R>;
      },
      release: () => { this.releases += 1; },
    };
  }

  done(): void {
    assert.equal(this.steps.length, 0, '仍有未使用的 SQL 脚本');
    assert.equal(this.connections, this.releases, '每个数据库连接都必须释放');
  }
}

const now = Date.parse('2026-08-13T09:00:00.000Z');
const iso = (offset = 0) => new Date(now + offset).toISOString();
const principalRow = {
  session_id: 'session-owner', user_id: 'user-owner', created_at: iso(-2_000), expires_at: iso(60_000),
  last_seen_at: iso(-1_000), revoked_at: null, display_name: '小秦', user_status: 'active',
  user_created_at: iso(-5_000), user_deleted_at: null,
};
const householdRow = {
  id: 'home-db', name: '我的冰箱', timezone: 'Asia/Shanghai', owner_user_id: 'user-owner', status: 'active',
  version: '1', created_at: iso(-5_000), deleted_at: null,
};
const ownerRow = {
  household_id: 'home-db', user_id: 'user-owner', role: 'owner', status: 'active', joined_at: iso(-5_000), version: '1',
};
const memberRow = {
  household_id: 'home-db', user_id: 'user-member', role: 'member', status: 'active', joined_at: iso(-4_000), version: '1',
};

function authSteps(): SqlStep[] {
  return [
    { includes: "s.token_hash = decode($1, 'hex')", rows: [principalRow] },
    { includes: 'UPDATE device_sessions SET last_seen_at' },
  ];
}

function transactionStart(): SqlStep[] {
  return [
    { includes: 'BEGIN' },
    { includes: 'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE' },
    { includes: "set_config('statement_timeout'" },
    { includes: "set_config('lock_timeout'" },
  ];
}

function appendChange(cursor: number): SqlStep[] {
  return [
    { includes: 'INSERT INTO household_sync_cursors' },
    { includes: 'UPDATE household_sync_cursors', rows: [{ current_cursor: cursor }] },
    { includes: 'INSERT INTO sync_changes' },
  ];
}

function service(pool: PgPoolLike) {
  return new PostgresHouseholdService(pool, {
    now: () => now,
    maxHouseholdsPerUser: 5,
    maxMembersPerHousehold: 10,
    invitationTtlMs: 60_000,
  });
}

describe('2.0 PostgreSQL 家庭、成员与邀请', () => {
  it('52. 创建家庭在 SERIALIZABLE 事务内锁定用户配额并原子写入 owner、cursor、变更与审计', async () => {
    const pool = new ScriptedPool([
      ...authSteps(), ...transactionStart(),
      { includes: 'pg_advisory_xact_lock' },
      { includes: 'count(*)::int AS count', rows: [{ count: 1 }] },
      { includes: 'INSERT INTO households' },
      { includes: 'INSERT INTO household_members' },
      { includes: 'INSERT INTO household_sync_cursors' },
      { includes: 'INSERT INTO sync_changes' },
      { includes: 'INSERT INTO audit_logs' },
      { includes: 'COMMIT' },
    ]);
    const created = await service(pool).createHousehold('opaque-access-token', '  周末厨房  ', 'Asia/Shanghai');
    assert.equal(created.name, '周末厨房');
    assert.equal(created.ownerUserId, 'user-owner');
    const advisory = pool.calls.find((item) => item.text.includes('pg_advisory_xact_lock'))!;
    assert.equal(advisory.values[0], 'user-households:user-owner');
    const sync = pool.calls.find((item) => item.text.includes('INSERT INTO sync_changes'))!;
    assert.ok(sync.text.includes("'household'"));
    assert.ok(sync.text.includes("'member'"));
    pool.done();
  });

  it('53. 接受邀请只传入 token 哈希，锁定邀请、家庭与用户配额后恢复成员并追加同步变更', async () => {
    const invitation = {
      id: 'invite-db', household_id: 'home-db', role: 'member', expires_at: iso(60_000), max_uses: 2,
      used_count: 0, created_by: 'user-owner', created_at: iso(-1_000), revoked_at: null,
    };
    const accepted = { ...memberRow, version: '3', joined_at: iso() };
    const pool = new ScriptedPool([
      ...authSteps(), ...transactionStart(),
      { includes: 'pg_advisory_xact_lock' },
      { includes: "token_hash = decode($1, 'hex')", rows: [invitation] },
      { includes: 'pg_advisory_xact_lock' },
      { includes: 'pg_advisory_xact_lock' },
      { includes: "FROM households WHERE id = $1 AND status = 'active' FOR UPDATE", rows: [householdRow] },
      { includes: 'FROM household_members WHERE household_id = $1 AND user_id = $2 FOR UPDATE', rows: [{ ...memberRow, status: 'removed', version: '2' }] },
      { includes: 'JOIN households h', rows: [{ count: 1 }] },
      { includes: 'FROM household_members', rows: [{ count: 2 }] },
      { includes: 'INSERT INTO household_members', rows: [accepted] },
      { includes: 'UPDATE invitations SET used_count' },
      ...appendChange(3),
      { includes: 'INSERT INTO audit_logs' },
      { includes: 'COMMIT' },
    ]);
    const member = await service(pool).acceptInvitation('opaque-access-token', 'join-secret');
    assert.equal(member.version, 3);
    assert.equal(member.status, 'active');
    const inviteQuery = pool.calls.find((item) => item.text.includes('FROM invitations'))!;
    assert.equal(typeof inviteQuery.values[0], 'string');
    assert.equal((inviteQuery.values[0] as string).length, 64);
    assert.ok(!JSON.stringify(pool.calls).includes('join-secret'));
    assert.deepEqual(
      pool.calls.filter((item) => item.text.includes('pg_advisory_xact_lock')).map((item) => item.values[0]),
      [`invitation:${inviteQuery.values[0]}`, 'household:home-db', 'user-households:user-owner'],
    );
    pool.done();
  });

  it('54. 所有权转移先降级旧 owner 再升级新 owner，并在同一事务追加三条变更', async () => {
    const pool = new ScriptedPool([
      ...authSteps(), ...transactionStart(),
      { includes: 'pg_advisory_xact_lock' },
      { includes: 'FROM household_members m JOIN households h', rows: [ownerRow] },
      { includes: 'FROM household_members WHERE household_id = $1 AND user_id = $2 FOR UPDATE', rows: [memberRow] },
      { includes: "FROM households WHERE id = $1 AND status = 'active' FOR UPDATE", rows: [householdRow] },
      { includes: "SET role = 'admin'", rows: [{ ...ownerRow, role: 'admin', version: '2' }] },
      { includes: "SET role = 'owner'", rows: [{ ...memberRow, role: 'owner', version: '2' }] },
      { includes: 'UPDATE households SET owner_user_id', rows: [{ ...householdRow, owner_user_id: 'user-member', version: '2' }] },
      ...appendChange(3), ...appendChange(4), ...appendChange(5),
      { includes: 'INSERT INTO audit_logs' },
      { includes: 'COMMIT' },
    ]);
    const household = await service(pool).transferOwnership('opaque-access-token', 'home-db', 'user-member');
    assert.equal(household.ownerUserId, 'user-member');
    const oldOwnerUpdate = pool.calls.findIndex((item) => item.text.includes("SET role = 'admin'"));
    const newOwnerUpdate = pool.calls.findIndex((item) => item.text.includes("SET role = 'owner'"));
    assert.ok(oldOwnerUpdate >= 0 && oldOwnerUpdate < newOwnerUpdate);
    assert.equal(pool.calls.filter((item) => item.text.includes('INSERT INTO sync_changes')).length, 3);
    pool.done();
  });

  it('55. 事务内角色复核拒绝访客创建邀请，回滚且不写邀请或审计', async () => {
    const pool = new ScriptedPool([
      ...authSteps(), ...transactionStart(),
      { includes: 'pg_advisory_xact_lock' },
      { includes: 'FROM household_members m JOIN households h', rows: [{ ...ownerRow, role: 'viewer' }] },
      { includes: 'ROLLBACK' },
    ]);
    await assert.rejects(
      service(pool).createInvitation('opaque-access-token', 'home-db'),
      (error: any) => error?.code === 'HOUSEHOLD_FORBIDDEN',
    );
    assert.ok(!pool.calls.some((item) => item.text.includes('INSERT INTO invitations')));
    assert.ok(!pool.calls.some((item) => item.text.includes('INSERT INTO audit_logs')));
    pool.done();
  });
});
