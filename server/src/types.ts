import type {
  AppSettings,
  CookingRecord,
  PantryBatch,
  RecipeProgress,
  ShoppingItem,
  StorageMode,
} from '../../miniprogram/domain/models.js';

export type UserStatus = 'active' | 'frozen' | 'deletionPending' | 'deleted';
export type HouseholdStatus = 'active' | 'deletionPending' | 'deleted';
export type MembershipStatus = 'active' | 'removed' | 'frozen';
export type HouseholdRole = 'owner' | 'admin' | 'member' | 'viewer';
export type Permission =
  | 'household:read'
  | 'inventory:write'
  | 'cooking:write'
  | 'shopping:write'
  | 'household:settings'
  | 'members:invite'
  | 'members:remove'
  | 'members:role'
  | 'household:transfer'
  | 'household:delete';

export interface User {
  id: string;
  displayName: string;
  status: UserStatus;
  createdAt: number;
  deletedAt?: number;
}

export interface AuthIdentity {
  userId: string;
  provider: 'wechat-miniprogram';
  appId: string;
  providerSubject: string;
  createdAt: number;
}

export interface DeviceSession {
  id: string;
  userId: string;
  deviceIdHash: string;
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
  revokedAt?: number;
}

export interface Household {
  id: string;
  name: string;
  timezone: string;
  ownerUserId: string;
  status: HouseholdStatus;
  version: number;
  createdAt: number;
  deletedAt?: number;
}

export interface HouseholdMember {
  householdId: string;
  userId: string;
  role: HouseholdRole;
  status: MembershipStatus;
  joinedAt: number;
  version: number;
  displayName?: string;
}

export interface Invitation {
  id: string;
  householdId: string;
  tokenHash: string;
  role: Exclude<HouseholdRole, 'owner'>;
  expiresAt: number;
  maxUses: number;
  usedCount: number;
  createdBy: string;
  createdAt: number;
  revokedAt?: number;
}

export interface ServerPantryBatch extends PantryBatch {
  householdId: string;
  originalQuantity: number;
  version: number;
  createdBy: string;
  deletedAt?: number;
}

export type InventoryMovementType = 'purchase' | 'cook_consume' | 'adjust' | 'discard';

export interface InventoryMovement {
  id: string;
  householdId: string;
  pantryBatchId: string;
  ingredientId: string;
  type: InventoryMovementType;
  quantityDelta: number;
  unit: string;
  actorUserId: string;
  sourceMutationId: string;
  occurredAt: number;
}

export interface ServerShoppingItem extends ShoppingItem {
  householdId: string;
  version: number;
  createdBy: string;
  updatedAt: number;
  deletedAt?: number;
}

export interface ServerCookingRecord extends CookingRecord {
  householdId: string;
  actorUserId: string;
  mutationId: string;
  version: number;
}

export interface ServerRecipeProgress extends RecipeProgress {
  userId: string;
  householdId: string;
  version: number;
}

export interface MemberPreferences extends AppSettings {
  userId: string;
  householdId: string;
  version: number;
  updatedAt: number;
}

export type SyncEntityType =
  | 'household'
  | 'member'
  | 'pantryBatch'
  | 'inventoryMovement'
  | 'shoppingItem'
  | 'cookingRecord'
  | 'recipeProgress'
  | 'preferences';

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

export type SyncCommandName =
  | 'PurchaseBatch'
  | 'CompleteCooking'
  | 'AddShoppingItem'
  | 'CheckShoppingItem'
  | 'RemoveShoppingItem'
  | 'DiscardBatch'
  | 'UnlockRecipe'
  | 'UpdatePreferences';

interface SyncCommandBase<TName extends SyncCommandName, TPayload> {
  mutationId: string;
  deviceId: string;
  householdId: string;
  command: TName;
  entityId: string;
  baseVersion: number;
  payload: TPayload;
  clientOccurredAt: string;
}

export type SyncCommand =
  | SyncCommandBase<'PurchaseBatch', {
      ingredientId: string;
      quantity: number;
      unit: string;
      purchasedAt: string;
      storageMode: StorageMode;
      shelfLifeDaysOverride?: number;
      note?: string;
      shoppingItemId?: string;
    }>
  | SyncCommandBase<'CompleteCooking', { recipeId: string; servings: number }>
  | SyncCommandBase<'AddShoppingItem', {
      ingredientId: string;
      suggestedQuantity: number;
      unit: string;
      sourceRecipeId?: string;
    }>
  | SyncCommandBase<'CheckShoppingItem', { checked: boolean }>
  | SyncCommandBase<'RemoveShoppingItem', Record<string, never>>
  | SyncCommandBase<'DiscardBatch', Record<string, never>>
  | SyncCommandBase<'UnlockRecipe', { recipeId: string }>
  | SyncCommandBase<'UpdatePreferences', {
      freshnessReminderDays?: number;
      defaultStorageMode?: StorageMode;
      favoriteRecipeIds?: string[];
    }>;

export interface ProcessedMutation {
  userId: string;
  mutationId: string;
  householdId: string;
  result: PushResult;
  processedAt: number;
}

export interface PushResult {
  mutationId: string;
  accepted: true;
  replayed: boolean;
  cursor: number;
  canonical: unknown;
}

export interface SyncConflict {
  id: string;
  mutationId: string;
  householdId: string;
  type: 'INVENTORY_CONFLICT' | 'VERSION_CONFLICT' | 'MEMBERSHIP_CHANGED';
  command: SyncCommandName;
  clientOccurredAt: string;
  serverValue?: unknown;
  recommendation: string;
  createdAt: number;
}

export interface HouseholdSnapshot {
  household: Household;
  members: HouseholdMember[];
  batches: ServerPantryBatch[];
  movements: InventoryMovement[];
  shoppingItems: ServerShoppingItem[];
  cookingRecords: ServerCookingRecord[];
  recipeProgress: ServerRecipeProgress[];
  preferences: MemberPreferences;
  cursor: number;
  catalogVersion: number;
}

export interface SessionPrincipal {
  user: User;
  session: DeviceSession;
}

export interface LoginResult {
  accessToken: string;
  expiresAt: number;
  user: User;
  households: Household[];
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

export interface DataExportHousehold {
  scope: 'owner-full' | 'member-readable';
  household: Household;
  membership: HouseholdMember;
  members: Array<Pick<HouseholdMember, 'userId' | 'role' | 'status' | 'joinedAt' | 'version'> & { displayName: string }>;
  batches: ServerPantryBatch[];
  movements: InventoryMovement[];
  shoppingItems: ServerShoppingItem[];
  cookingRecords: ServerCookingRecord[];
  recipeProgress: ServerRecipeProgress[];
  preferences: MemberPreferences;
}

export interface DataExportArtifact {
  id: string;
  userId: string;
  status: 'ready' | 'expired';
  createdAt: number;
  expiresAt: number;
  checksum: string;
  payload: {
    format: 'bingxiang-v2-user-export';
    exportedAt: number;
    user: User;
    sessions: Array<Omit<DeviceSession, 'tokenHash' | 'deviceIdHash'>>;
    households: DataExportHousehold[];
    exclusions: string[];
  };
}

export interface AccountDeletionRequest {
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

export interface AuditLog {
  id: string;
  actorUserId?: string;
  householdId?: string;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata: Record<string, unknown>;
  createdAt: number;
}
