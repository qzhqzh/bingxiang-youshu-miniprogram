import type { CloudRepository } from '../types';
import type { PullPage, PushResult, SyncCommand } from '../../v2/models';
import type { BootstrapResponse, RemoteSyncGateway } from '../../services/cloud/remote-sync.gateway';

export class CloudAppRepository implements CloudRepository {
  constructor(private readonly gateway: RemoteSyncGateway) {}
  bootstrap(accessToken: string, householdId: string): Promise<BootstrapResponse> {
    return this.gateway.bootstrap(accessToken, householdId);
  }
  push(accessToken: string, command: SyncCommand): Promise<PushResult> {
    return this.gateway.push(accessToken, command);
  }
  pull(accessToken: string, householdId: string, cursor: number, limit?: number): Promise<PullPage> {
    return this.gateway.pull(accessToken, householdId, cursor, limit);
  }
}
