import type { QueryResultRow } from 'pg';
import { ApiError } from '../errors.js';
import { hashSecret, newId, newOpaqueToken } from '../security.js';
import type { DeviceSession, Household, LoginResult, User } from '../types.js';
import type { WechatIdentityProvider } from '../wechat.js';
import { PostgresQueryStore } from './query-store.js';
import type { PgClientLike, PgPoolLike } from './mutation-executor.js';

interface IdentityServiceOptions {
  appId: string;
  sessionTtlMs?: number;
  now?: () => number;
}

interface IdentityUserRow extends QueryResultRow {
  id: string;
  display_name: string;
  status: User['status'];
  created_at: Date | string;
  deleted_at: Date | string | null;
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

interface SessionRow extends QueryResultRow {
  id: string;
  user_id: string;
  created_at: Date | string;
  expires_at: Date | string;
  last_seen_at: Date | string;
  revoked_at: Date | string | null;
}

function asTime(value: Date | string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error('数据库返回了无效时间');
  return parsed;
}

function asUser(row: IdentityUserRow): User {
  return {
    id: row.id,
    displayName: row.display_name,
    status: row.status,
    createdAt: asTime(row.created_at)!,
    ...(row.deleted_at ? { deletedAt: asTime(row.deleted_at)! } : {}),
  };
}

function asHousehold(row: HouseholdRow): Household {
  return {
    id: row.id,
    name: row.name,
    timezone: row.timezone,
    ownerUserId: row.owner_user_id,
    status: row.status,
    version: Number(row.version),
    createdAt: asTime(row.created_at)!,
    ...(row.deleted_at ? { deletedAt: asTime(row.deleted_at)! } : {}),
  };
}

/** PostgreSQL 身份与设备会话服务；不把 access token 或设备原始 ID 写入数据库。 */
export class PostgresIdentityService {
  private readonly now: () => number;
  private readonly sessionTtlMs: number;
  private readonly queryStore: PostgresQueryStore;

  constructor(
    private readonly pool: PgPoolLike,
    private readonly wechat: WechatIdentityProvider,
    private readonly options: IdentityServiceOptions,
  ) {
    if (!options.appId) throw new Error('服务端 AppID 未配置');
    this.now = options.now ?? Date.now;
    this.sessionTtlMs = options.sessionTtlMs ?? 2 * 60 * 60 * 1_000;
    this.queryStore = new PostgresQueryStore({
      query: (text, values) => this.withClientQuery(text, values),
    }, { now: this.now });
  }

  async loginWechat(code: string, deviceId: string): Promise<LoginResult> {
    if (!deviceId?.trim()) throw new ApiError('VALIDATION_ERROR', '缺少设备 ID', 400);
    const identity = await this.wechat.exchange(code);
    const accessToken = newOpaqueToken();
    const sessionId = newId('ses');
    const now = this.now();
    return this.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `identity:wechat-miniprogram:${this.options.appId}:${identity.providerSubject}`,
      ]);
      const existing = await client.query<IdentityUserRow>(
        `SELECT u.id, u.display_name, u.status, u.created_at, u.deleted_at
         FROM auth_identities i JOIN users u ON u.id = i.user_id
         WHERE i.provider = 'wechat-miniprogram' AND i.app_id = $1 AND i.provider_subject = $2
         FOR UPDATE OF u`,
        [this.options.appId, identity.providerSubject],
      );
      let user: User;
      if (existing.rows[0]) {
        user = asUser(existing.rows[0]);
        if (user.status !== 'active') throw new ApiError('UNAUTHENTICATED', '账号不可用', 401);
      } else {
        user = await this.createUserAndDefaultHousehold(client, identity.providerSubject, now);
      }
      const expiresAt = now + this.sessionTtlMs;
      await client.query(
        `INSERT INTO device_sessions
           (id, user_id, device_id_hash, token_hash, created_at, expires_at, last_seen_at)
         VALUES ($1, $2, decode($3, 'hex'), decode($4, 'hex'), $5, $6, $5)`,
        [sessionId, user.id, hashSecret(deviceId), hashSecret(accessToken), new Date(now), new Date(expiresAt)],
      );
      const households = await this.householdsFor(client, user.id);
      return { accessToken, expiresAt, user, households };
    });
  }

  async logout(accessToken: string): Promise<void> {
    const principal = await this.queryStore.authenticate(accessToken, true);
    await this.withClientQuery(
      `UPDATE device_sessions SET revoked_at = COALESCE(revoked_at, $2) WHERE id = $1`,
      [principal.session.id, new Date(this.now())],
    );
  }

  async me(accessToken: string): Promise<User> {
    return (await this.queryStore.authenticate(accessToken)).user;
  }

  async updateProfile(accessToken: string, displayName: string): Promise<User> {
    const principal = await this.queryStore.authenticate(accessToken);
    const normalized = displayName.trim();
    if (normalized.length < 1 || normalized.length > 30) throw new ApiError('VALIDATION_ERROR', '显示名称应为 1–30 个字符', 400);
    const result = await this.withClientQuery<IdentityUserRow>(
      `UPDATE users SET display_name = $2
       WHERE id = $1 AND status = 'active'
       RETURNING id, display_name, status, created_at, deleted_at`,
      [principal.user.id, normalized],
    );
    if (!result.rows[0]) throw new ApiError('UNAUTHENTICATED', '账号不可用', 401);
    return asUser(result.rows[0]);
  }

  async listSessions(accessToken: string): Promise<Array<Omit<DeviceSession, 'tokenHash' | 'deviceIdHash'>>> {
    const principal = await this.queryStore.authenticate(accessToken, true);
    const result = await this.withClientQuery<SessionRow>(
      `SELECT id, user_id, created_at, expires_at, last_seen_at, revoked_at
       FROM device_sessions WHERE user_id = $1 ORDER BY last_seen_at DESC, id`,
      [principal.user.id],
    );
    return result.rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      createdAt: asTime(row.created_at)!,
      expiresAt: asTime(row.expires_at)!,
      lastSeenAt: asTime(row.last_seen_at)!,
      ...(row.revoked_at ? { revokedAt: asTime(row.revoked_at)! } : {}),
    }));
  }

  async revokeSession(accessToken: string, sessionId: string): Promise<void> {
    const principal = await this.queryStore.authenticate(accessToken, true);
    const result = await this.withClientQuery(
      `UPDATE device_sessions SET revoked_at = COALESCE(revoked_at, $3)
       WHERE id = $1 AND user_id = $2`,
      [sessionId, principal.user.id, new Date(this.now())],
    );
    if (!result.rowCount) throw new ApiError('NOT_FOUND', '没有找到这个设备会话', 404);
  }

  private async createUserAndDefaultHousehold(client: PgClientLike, providerSubject: string, now: number): Promise<User> {
    const user: User = { id: newId('usr'), displayName: '家庭成员', status: 'active', createdAt: now };
    const household: Household = {
      id: newId('hh'), name: '我的冰箱', timezone: 'Asia/Shanghai', ownerUserId: user.id,
      status: 'active', version: 1, createdAt: now,
    };
    await client.query('INSERT INTO users (id, display_name, status, created_at) VALUES ($1, $2, $3, $4)', [
      user.id, user.displayName, user.status, new Date(now),
    ]);
    await client.query(
      `INSERT INTO auth_identities (provider, app_id, provider_subject, user_id, created_at)
       VALUES ('wechat-miniprogram', $1, $2, $3, $4)`,
      [this.options.appId, providerSubject, user.id, new Date(now)],
    );
    await client.query(
      `INSERT INTO households (id, name, timezone, owner_user_id, status, version, created_at)
       VALUES ($1, $2, $3, $4, 'active', 1, $5)`,
      [household.id, household.name, household.timezone, user.id, new Date(now)],
    );
    await client.query(
      `INSERT INTO household_members (household_id, user_id, role, status, joined_at, version)
       VALUES ($1, $2, 'owner', 'active', $3, 1)`,
      [household.id, user.id, new Date(now)],
    );
    await client.query(
      `INSERT INTO household_sync_cursors (household_id, current_cursor, minimum_cursor) VALUES ($1, 2, 0)`,
      [household.id],
    );
    await client.query(
      `INSERT INTO sync_changes
         (household_id, cursor, entity_type, entity_id, operation, version, payload, server_time)
       VALUES
         ($1, 1, 'household', $1, 'upsert', 1, $2::jsonb, $4),
         ($1, 2, 'member', $3, 'upsert', 1, $5::jsonb, $4)`,
      [
        household.id,
        JSON.stringify(household),
        user.id,
        new Date(now),
        JSON.stringify({ householdId: household.id, userId: user.id, role: 'owner', status: 'active', joinedAt: now, version: 1 }),
      ],
    );
    return user;
  }

  private async householdsFor(client: PgClientLike, userId: string): Promise<Household[]> {
    const result = await client.query<HouseholdRow>(
      `SELECT h.id, h.name, h.timezone, h.owner_user_id, h.status, h.version, h.created_at, h.deleted_at
       FROM households h JOIN household_members m ON m.household_id = h.id
       WHERE m.user_id = $1 AND m.status = 'active' AND h.status = 'active'
       ORDER BY h.created_at, h.id`,
      [userId],
    );
    return result.rows.map(asHousehold);
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
