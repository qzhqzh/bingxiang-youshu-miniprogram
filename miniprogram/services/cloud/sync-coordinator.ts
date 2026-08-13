import { LocalV2Repository } from '../../repositories/local/local-v2.repository';
import type { LocalConflict, SyncChange, SyncEntityType } from '../../v2/models';
import type { BootstrapResponse, RemoteSyncGateway } from './remote-sync.gateway';
import { RemoteApiError } from './remote-sync.gateway';

export interface SyncOutcome {
  pushed: number;
  pulled: number;
  conflicts: number;
  offline: boolean;
  fullResynced: boolean;
}

const conflictCodes = new Set(['INVENTORY_CONFLICT', 'VERSION_CONFLICT', 'MEMBERSHIP_CHANGED', 'MUTATION_REJECTED']);

function bootstrapChanges(snapshot: BootstrapResponse): SyncChange[] {
  const changes: SyncChange[] = [];
  const add = (entityType: SyncEntityType, entityId: string, version: number, payload: unknown) => {
    changes.push({
      householdId: snapshot.household.id,
      cursor: snapshot.cursor,
      entityType,
      entityId,
      operation: 'upsert',
      version,
      payload,
      serverTime: Date.now(),
    });
  };
  add('household', snapshot.household.id, snapshot.household.version, snapshot.household);
  snapshot.members.forEach((item) => add('member', item.userId, item.version, item));
  snapshot.batches.forEach((item) => add('pantryBatch', item.id, item.version, item));
  snapshot.movements.forEach((item) => add('inventoryMovement', item.id, 1, item));
  snapshot.shoppingItems.forEach((item) => add('shoppingItem', item.id, item.version, item));
  snapshot.cookingRecords.forEach((item) => add('cookingRecord', item.id, item.version, item));
  snapshot.recipeProgress.forEach((item) => add('recipeProgress', `${item.userId}:${item.recipeId}`, item.version, item));
  add('preferences', snapshot.preferences.userId, snapshot.preferences.version, snapshot.preferences);
  return changes;
}

export class SyncCoordinator {
  constructor(
    private readonly local: LocalV2Repository,
    private readonly remote: RemoteSyncGateway,
    private readonly now: () => number = Date.now,
  ) {}

  async sync(accessToken: string, householdId: string): Promise<SyncOutcome> {
    const outcome: SyncOutcome = { pushed: 0, pulled: 0, conflicts: 0, offline: false, fullResynced: false };
    const due = this.local.envelope(householdId).outbox
      .filter((item) => item.state !== 'conflict' && item.nextAttemptAt <= this.now())
      .sort((a, b) => a.createdAt - b.createdAt);

    for (const queued of due) {
      this.local.markSending(householdId, queued.command.mutationId);
      try {
        await this.remote.push(accessToken, queued.command);
        this.local.acknowledge(householdId, queued.command.mutationId);
        outcome.pushed += 1;
      } catch (error) {
        if (error instanceof RemoteApiError && conflictCodes.has(error.code)) {
          const details = error.details as { serverValue?: unknown } | undefined;
          const conflict: LocalConflict = {
            id: `conflict_${queued.command.mutationId}`,
            mutationId: queued.command.mutationId,
            householdId,
            type: error.code as LocalConflict['type'],
            command: queued.command.command,
            recommendation: error.code === 'MEMBERSHIP_CHANGED'
              ? '你已不在这个家庭中；停止重试并保留操作供手工处理。'
              : '请查看服务端最新数据后重新确认。',
            createdAt: this.now(),
            ...(details?.serverValue === undefined ? {} : { serverValue: details.serverValue }),
          };
          this.local.recordConflict(householdId, conflict);
          outcome.conflicts += 1;
          if (error.code === 'MEMBERSHIP_CHANGED') return outcome;
          continue;
        }
        const attempts = queued.attemptCount + 1;
        this.local.retryLater(householdId, queued.command.mutationId, 'NETWORK_UNAVAILABLE', Math.min(2 ** attempts * 1_000, 60_000));
        outcome.offline = true;
        return outcome;
      }
    }

    try {
      let hasMore = true;
      while (hasMore) {
        const cursor = this.local.envelope(householdId).cursor;
        const page = await this.remote.pull(accessToken, householdId, cursor);
        this.local.applyChanges(householdId, page.changes, page.nextCursor, page.catalogVersion);
        outcome.pulled += page.changes.length;
        hasMore = page.hasMore;
      }
    } catch (error) {
      if (error instanceof RemoteApiError && error.code === 'FULL_RESYNC_REQUIRED') {
        const snapshot = await this.remote.bootstrap(accessToken, householdId);
        this.local.replaceSnapshot(householdId, bootstrapChanges(snapshot), snapshot.cursor, snapshot.catalogVersion);
        outcome.fullResynced = true;
      } else {
        outcome.offline = true;
      }
    }
    return outcome;
  }
}
