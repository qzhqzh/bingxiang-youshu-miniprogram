import type {
  Household,
  HouseholdMember,
  HouseholdRole,
  HouseholdSnapshot,
  LoginResult,
  MigrationSummary,
  PushResult,
  SyncChange,
  SyncCommand,
  User,
} from './types.js';

type Awaitable<T> = T | Promise<T>;

export interface PullResult {
  changes: SyncChange[];
  nextCursor: number;
  hasMore: boolean;
  catalogVersion: number;
}

/** HTTP 层只依赖此异步友好契约，避免与内存 Map 实现耦合。 */
export interface V2ApiService {
  loginWechat(code: string, deviceId: string): Awaitable<LoginResult>;
  logout(accessToken: string): Awaitable<void>;
  me(accessToken: string): Awaitable<User>;
  updateProfile(accessToken: string, displayName: string): Awaitable<User>;
  listSessions(accessToken: string): Awaitable<unknown[]>;
  revokeSession(accessToken: string, sessionId: string): Awaitable<void>;
  listHouseholds(accessToken: string): Awaitable<Household[]>;
  createHousehold(accessToken: string, name: string, timezone?: string): Awaitable<Household>;
  updateHousehold(accessToken: string, householdId: string, input: { name?: string; timezone?: string }): Awaitable<Household>;
  createInvitation(
    accessToken: string,
    householdId: string,
    role?: Exclude<HouseholdRole, 'owner'>,
    maxUses?: number,
  ): Awaitable<unknown>;
  revokeInvitation(accessToken: string, householdId: string, invitationId: string): Awaitable<void>;
  acceptInvitation(accessToken: string, token: string): Awaitable<HouseholdMember>;
  updateMemberRole(
    accessToken: string,
    householdId: string,
    targetUserId: string,
    role: Exclude<HouseholdRole, 'owner'>,
  ): Awaitable<HouseholdMember>;
  removeMember(accessToken: string, householdId: string, targetUserId: string): Awaitable<void>;
  transferOwnership(accessToken: string, householdId: string, targetUserId: string): Awaitable<Household>;
  bootstrap(accessToken: string, householdId: string): Awaitable<HouseholdSnapshot>;
  push(accessToken: string, command: SyncCommand): Awaitable<PushResult>;
  pull(accessToken: string, householdId: string, cursor: number, limit?: number): Awaitable<PullResult>;
  prepareV1Migration(accessToken: string, householdId: string, importBatchId: string, source: string): Awaitable<MigrationSummary>;
  commitV1Migration(accessToken: string, householdId: string, importBatchId: string, source: string): Awaitable<MigrationSummary>;
  migrationStatus(accessToken: string, importBatchId: string): Awaitable<MigrationSummary>;
}
