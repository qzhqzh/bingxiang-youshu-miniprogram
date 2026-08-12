import type {
  AuthIdentity,
  AccountDeletionRequest,
  AuditLog,
  DataExportArtifact,
  DeviceSession,
  Household,
  HouseholdMember,
  Invitation,
  InventoryMovement,
  MemberPreferences,
  MigrationSummary,
  ProcessedMutation,
  ServerCookingRecord,
  ServerPantryBatch,
  ServerRecipeProgress,
  ServerShoppingItem,
  SyncChange,
  SyncEntityType,
  User,
} from './types.js';

export interface V2Limits {
  maxHouseholdsPerUser: number;
  maxMembersPerHousehold: number;
  invitationTtlMs: number;
  pullPageSize: number;
}

export const defaultLimits: V2Limits = {
  maxHouseholdsPerUser: 5,
  maxMembersPerHousehold: 10,
  invitationTtlMs: 72 * 60 * 60 * 1_000,
  pullPageSize: 200,
};

export class InMemoryV2Store {
  readonly users = new Map<string, User>();
  readonly identities = new Map<string, AuthIdentity>();
  readonly sessions = new Map<string, DeviceSession>();
  readonly households = new Map<string, Household>();
  readonly members = new Map<string, HouseholdMember>();
  readonly invitations = new Map<string, Invitation>();
  readonly batches = new Map<string, ServerPantryBatch>();
  readonly movements = new Map<string, InventoryMovement>();
  readonly shoppingItems = new Map<string, ServerShoppingItem>();
  readonly cookingRecords = new Map<string, ServerCookingRecord>();
  readonly recipeProgress = new Map<string, ServerRecipeProgress>();
  readonly preferences = new Map<string, MemberPreferences>();
  readonly processedMutations = new Map<string, ProcessedMutation>();
  readonly migrations = new Map<string, MigrationSummary>();
  readonly changes = new Map<string, SyncChange[]>();
  readonly dataExports = new Map<string, DataExportArtifact>();
  readonly deletionRequests = new Map<string, AccountDeletionRequest>();
  readonly auditLogs = new Map<string, AuditLog>();
  readonly minimumCursors = new Map<string, number>();
  private readonly householdLocks = new Map<string, Promise<void>>();

  constructor(readonly limits: V2Limits = defaultLimits) {}

  identityKey(appId: string, providerSubject: string): string {
    return `wechat-miniprogram:${appId}:${providerSubject}`;
  }

  memberKey(householdId: string, userId: string): string {
    return `${householdId}:${userId}`;
  }

  preferencesKey(householdId: string, userId: string): string {
    return `${householdId}:${userId}`;
  }

  progressKey(householdId: string, userId: string, recipeId: string): string {
    return `${householdId}:${userId}:${recipeId}`;
  }

  mutationKey(userId: string, mutationId: string): string {
    return `${userId}:${mutationId}`;
  }

  migrationKey(userId: string, importBatchId: string): string {
    return `${userId}:${importBatchId}`;
  }

  activeMembers(householdId: string): HouseholdMember[] {
    return [...this.members.values()].filter((item) => item.householdId === householdId && item.status === 'active');
  }

  activeMemberships(userId: string): HouseholdMember[] {
    return [...this.members.values()].filter((item) => item.userId === userId && item.status === 'active');
  }

  appendChange(
    householdId: string,
    entityType: SyncEntityType,
    entityId: string,
    operation: 'upsert' | 'delete',
    version: number,
    payload: unknown,
    serverTime: number,
  ): SyncChange {
    const list = this.changes.get(householdId) ?? [];
    const change: SyncChange = {
      householdId,
      cursor: (list.at(-1)?.cursor ?? 0) + 1,
      entityType,
      entityId,
      operation,
      version,
      payload,
      serverTime,
    };
    list.push(change);
    this.changes.set(householdId, list);
    return change;
  }

  currentCursor(householdId: string): number {
    return this.changes.get(householdId)?.at(-1)?.cursor ?? 0;
  }

  compactBefore(householdId: string, cursor: number): void {
    this.changes.set(householdId, (this.changes.get(householdId) ?? []).filter((item) => item.cursor >= cursor));
    this.minimumCursors.set(householdId, cursor);
  }

  async runHouseholdExclusive<T>(householdId: string, task: () => Promise<T> | T): Promise<T> {
    const previous = this.householdLocks.get(householdId) ?? Promise.resolve();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const chain = previous.then(() => gate);
    this.householdLocks.set(householdId, chain);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.householdLocks.get(householdId) === chain) this.householdLocks.delete(householdId);
    }
  }
}
