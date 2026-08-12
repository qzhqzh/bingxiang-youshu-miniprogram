export type SyncEntityType =
  | 'household' | 'member' | 'pantryBatch' | 'inventoryMovement'
  | 'shoppingItem' | 'cookingRecord' | 'recipeProgress' | 'preferences';

export interface DeviceIdentity {
  deviceId: string;
  createdAt: number;
}

export interface CloudUser {
  id: string;
  displayName: string;
}

export interface CloudHousehold {
  id: string;
  name: string;
  timezone: string;
  ownerUserId: string;
  version: number;
}

export type CloudHouseholdRole = 'owner' | 'admin' | 'member' | 'viewer';

export interface CloudHouseholdMember {
  householdId: string;
  userId: string;
  displayName?: string;
  role: CloudHouseholdRole;
  status: 'active' | 'removed' | 'frozen';
  joinedAt: number;
  version: number;
}

export interface CloudInvitation {
  id: string;
  householdId: string;
  role: Exclude<CloudHouseholdRole, 'owner'>;
  expiresAt: number;
  maxUses: number;
  usedCount: number;
}

export interface CloudAuthState {
  mode: 'guest' | 'cloud';
  accessToken?: string;
  expiresAt?: number;
  user?: CloudUser;
  households: CloudHousehold[];
  activeHouseholdId?: string;
}

export interface SyncCommand {
  mutationId: string;
  deviceId: string;
  householdId: string;
  command: string;
  entityId: string;
  baseVersion: number;
  payload: unknown;
  clientOccurredAt: string;
}

export interface OutboxItem {
  command: SyncCommand;
  state: 'pending' | 'sending' | 'conflict';
  attemptCount: number;
  nextAttemptAt: number;
  createdAt: number;
  lastErrorCode?: string;
}

export interface LocalConflict {
  id: string;
  mutationId: string;
  householdId: string;
  type: 'INVENTORY_CONFLICT' | 'VERSION_CONFLICT' | 'MEMBERSHIP_CHANGED' | 'MUTATION_REJECTED';
  command: string;
  recommendation: string;
  serverValue?: unknown;
  createdAt: number;
}

export interface SyncChange {
  householdId: string;
  cursor: number;
  entityType: SyncEntityType;
  entityId: string;
  operation: 'upsert' | 'delete';
  version: number;
  payload: unknown;
  serverTime: number;
}

export interface LocalEntity {
  version: number;
  deleted: boolean;
  value: unknown;
}

export type EntityStore = Partial<Record<SyncEntityType, Record<string, LocalEntity>>>;

export interface HouseholdEnvelope {
  schemaVersion: 2;
  householdId: string;
  revision: number;
  cursor: number;
  catalogVersion: number;
  entities: EntityStore;
  outbox: OutboxItem[];
  conflicts: LocalConflict[];
  updatedAt: number;
}

export interface PullPage {
  changes: SyncChange[];
  nextCursor: number;
  hasMore: boolean;
  catalogVersion: number;
}

export interface PushResult {
  mutationId: string;
  accepted: true;
  replayed: boolean;
  cursor: number;
  canonical: unknown;
}

export interface MigrationSummary {
  importBatchId: string;
  householdId: string;
  batchCount: number;
  shoppingItemCount: number;
  cookingRecordCount: number;
  progressCount: number;
  checksum: string;
  status: 'prepared' | 'committed';
}

export interface CloudDataExportArtifact {
  id: string;
  userId: string;
  status: 'ready' | 'expired';
  createdAt: number;
  expiresAt: number;
  checksum: string;
  payload: Record<string, unknown>;
}

export interface CloudAccountDeletionRequest {
  id: string;
  userId: string;
  status: 'pending' | 'cancelled' | 'completed' | 'blocked';
  requestedAt: number;
  executeAfter: number;
  restrictedSessionId: string;
  cancelledAt?: number;
  completedAt?: number;
  blockedReason?: string;
}

export interface CloudStatusView {
  mode: 'guest' | 'cloud';
  available: boolean;
  activeHouseholdName: string;
  pendingCount: number;
  conflictCount: number;
  lastSyncedAt?: number;
}
