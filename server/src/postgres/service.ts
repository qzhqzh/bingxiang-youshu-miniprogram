import type { V2ApiService, PullResult } from '../api-service.js';
import type {
  AccountDeletionRequest,
  DataExportArtifact,
  Household,
  HouseholdMember,
  HouseholdRole,
  HouseholdSnapshot,
  LoginResult,
  MigrationSummary,
  PushResult,
  SyncCommand,
  User,
} from '../types.js';
import type { WechatIdentityProvider } from '../wechat.js';
import { PostgresHouseholdService } from './household-service.js';
import { PostgresIdentityService } from './identity-service.js';
import { PostgresMigrationService } from './migration-service.js';
import type { PgPoolLike } from './mutation-executor.js';
import { PostgresPrivacyService } from './privacy-service.js';
import { PostgresSyncService } from './sync-service.js';

export interface PostgresV2ServiceOptions {
  appId: string;
  sessionTtlMs?: number;
  catalogVersion?: number;
  maxHouseholdsPerUser?: number;
  maxMembersPerHousehold?: number;
  invitationTtlMs?: number;
  dataExportTtlMs?: number;
  deletionCoolingMs?: number;
  statementTimeoutMs?: number;
  lockTimeoutMs?: number;
  now?: () => number;
}

/**
 * PostgreSQL 生产服务组合根。HTTP 层只依赖 V2ApiService；每组领域能力仍由
 * 各自的小型服务负责，避免重新实现或绕过已有的鉴权与事务边界。
 */
export class PostgresV2Service implements V2ApiService {
  readonly privacy: PostgresPrivacyService;
  private readonly identity: PostgresIdentityService;
  private readonly households: PostgresHouseholdService;
  private readonly sync: PostgresSyncService;
  private readonly migrations: PostgresMigrationService;

  constructor(pool: PgPoolLike, wechat: WechatIdentityProvider, options: PostgresV2ServiceOptions) {
    const timing = {
      ...(options.now ? { now: options.now } : {}),
      ...(options.statementTimeoutMs === undefined ? {} : { statementTimeoutMs: options.statementTimeoutMs }),
      ...(options.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: options.lockTimeoutMs }),
    };
    this.identity = new PostgresIdentityService(pool, wechat, {
      appId: options.appId,
      ...(options.sessionTtlMs === undefined ? {} : { sessionTtlMs: options.sessionTtlMs }),
      ...(options.now ? { now: options.now } : {}),
    });
    this.households = new PostgresHouseholdService(pool, {
      ...timing,
      ...(options.maxHouseholdsPerUser === undefined ? {} : { maxHouseholdsPerUser: options.maxHouseholdsPerUser }),
      ...(options.maxMembersPerHousehold === undefined ? {} : { maxMembersPerHousehold: options.maxMembersPerHousehold }),
      ...(options.invitationTtlMs === undefined ? {} : { invitationTtlMs: options.invitationTtlMs }),
    });
    this.sync = new PostgresSyncService(pool, {
      ...(options.now ? { now: options.now } : {}),
      ...(options.catalogVersion === undefined ? {} : { catalogVersion: options.catalogVersion }),
    });
    this.privacy = new PostgresPrivacyService(pool, {
      ...timing,
      ...(options.dataExportTtlMs === undefined ? {} : { dataExportTtlMs: options.dataExportTtlMs }),
      ...(options.deletionCoolingMs === undefined ? {} : { deletionCoolingMs: options.deletionCoolingMs }),
    });
    this.migrations = new PostgresMigrationService(pool, timing);
  }

  loginWechat(code: string, deviceId: string): Promise<LoginResult> {
    return this.identity.loginWechat(code, deviceId);
  }

  logout(accessToken: string): Promise<void> { return this.identity.logout(accessToken); }
  me(accessToken: string): Promise<User> { return this.identity.me(accessToken); }
  updateProfile(accessToken: string, displayName: string): Promise<User> {
    return this.identity.updateProfile(accessToken, displayName);
  }
  listSessions(accessToken: string): Promise<unknown[]> { return this.identity.listSessions(accessToken); }
  revokeSession(accessToken: string, sessionId: string): Promise<void> {
    return this.identity.revokeSession(accessToken, sessionId);
  }

  createDataExport(accessToken: string): Promise<DataExportArtifact> {
    return this.privacy.createDataExport(accessToken);
  }
  requestAccountDeletion(accessToken: string, confirmation: string): Promise<AccountDeletionRequest> {
    return this.privacy.requestAccountDeletion(accessToken, confirmation);
  }
  accountDeletionStatus(accessToken: string): Promise<AccountDeletionRequest> {
    return this.privacy.accountDeletionStatus(accessToken);
  }
  cancelAccountDeletion(accessToken: string): Promise<AccountDeletionRequest> {
    return this.privacy.cancelAccountDeletion(accessToken);
  }

  listHouseholds(accessToken: string): Promise<Household[]> {
    return this.households.listHouseholds(accessToken);
  }
  createHousehold(accessToken: string, name: string, timezone?: string): Promise<Household> {
    return this.households.createHousehold(accessToken, name, timezone);
  }
  updateHousehold(
    accessToken: string,
    householdId: string,
    input: { name?: string; timezone?: string },
  ): Promise<Household> {
    return this.households.updateHousehold(accessToken, householdId, input);
  }
  createInvitation(
    accessToken: string,
    householdId: string,
    role?: Exclude<HouseholdRole, 'owner'>,
    maxUses?: number,
  ): Promise<unknown> {
    return this.households.createInvitation(accessToken, householdId, role, maxUses);
  }
  revokeInvitation(accessToken: string, householdId: string, invitationId: string): Promise<void> {
    return this.households.revokeInvitation(accessToken, householdId, invitationId);
  }
  acceptInvitation(accessToken: string, token: string): Promise<HouseholdMember> {
    return this.households.acceptInvitation(accessToken, token);
  }
  updateMemberRole(
    accessToken: string,
    householdId: string,
    targetUserId: string,
    role: Exclude<HouseholdRole, 'owner'>,
  ): Promise<HouseholdMember> {
    return this.households.updateMemberRole(accessToken, householdId, targetUserId, role);
  }
  removeMember(accessToken: string, householdId: string, targetUserId: string): Promise<void> {
    return this.households.removeMember(accessToken, householdId, targetUserId);
  }
  transferOwnership(accessToken: string, householdId: string, targetUserId: string): Promise<Household> {
    return this.households.transferOwnership(accessToken, householdId, targetUserId);
  }
  bootstrap(accessToken: string, householdId: string): Promise<HouseholdSnapshot> {
    return this.households.bootstrap(accessToken, householdId);
  }

  push(accessToken: string, command: SyncCommand): Promise<PushResult> {
    return this.sync.push(accessToken, command);
  }
  pull(accessToken: string, householdId: string, cursor: number, limit?: number): Promise<PullResult> {
    return this.sync.pull(accessToken, householdId, cursor, limit);
  }

  prepareV1Migration(
    accessToken: string,
    householdId: string,
    importBatchId: string,
    source: string,
  ): Promise<MigrationSummary> {
    return this.migrations.prepareV1Migration(accessToken, householdId, importBatchId, source);
  }
  commitV1Migration(
    accessToken: string,
    householdId: string,
    importBatchId: string,
    source: string,
  ): Promise<MigrationSummary> {
    return this.migrations.commitV1Migration(accessToken, householdId, importBatchId, source);
  }
  migrationStatus(accessToken: string, importBatchId: string): Promise<MigrationSummary> {
    return this.migrations.migrationStatus(accessToken, importBatchId);
  }

  executeDueAccountDeletions(at?: number, limit?: number): Promise<AccountDeletionRequest[]> {
    return this.privacy.executeDueAccountDeletions(at, limit);
  }
}
