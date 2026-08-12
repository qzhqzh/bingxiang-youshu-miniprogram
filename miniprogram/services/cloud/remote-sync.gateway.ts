import type {
  CloudHousehold,
  CloudHouseholdMember,
  CloudHouseholdRole,
  CloudInvitation,
  CloudUser,
  MigrationSummary,
  PullPage,
  PushResult,
  SyncCommand,
} from '../../v2/models';

export interface LoginResponse {
  accessToken: string;
  expiresAt: number;
  user: CloudUser;
  households: CloudHousehold[];
}

export interface BootstrapResponse {
  household: CloudHousehold;
  members: CloudHouseholdMember[];
  batches: Array<Record<string, unknown> & { id: string; version: number }>;
  movements: Array<Record<string, unknown> & { id: string }>;
  shoppingItems: Array<Record<string, unknown> & { id: string; version: number }>;
  cookingRecords: Array<Record<string, unknown> & { id: string; version: number }>;
  recipeProgress: Array<Record<string, unknown> & { recipeId: string; userId: string; version: number }>;
  preferences: Record<string, unknown> & { userId: string; version: number };
  cursor: number;
  catalogVersion: number;
}

export interface InvitationResponse {
  invitation: CloudInvitation;
  token: string;
}

export class RemoteApiError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode: number, readonly details?: unknown) {
    super(message);
    this.name = 'RemoteApiError';
  }
}

export interface RemoteSyncGateway {
  login(deviceId: string): Promise<LoginResponse>;
  logout(accessToken: string): Promise<void>;
  push(accessToken: string, command: SyncCommand): Promise<PushResult>;
  pull(accessToken: string, householdId: string, cursor: number, limit?: number): Promise<PullPage>;
  bootstrap(accessToken: string, householdId: string): Promise<BootstrapResponse>;
  prepareMigration(accessToken: string, householdId: string, importBatchId: string, source: string): Promise<MigrationSummary>;
  commitMigration(accessToken: string, householdId: string, importBatchId: string, source: string): Promise<MigrationSummary>;
}

export interface CloudAccountGateway extends RemoteSyncGateway {
  listHouseholds(accessToken: string): Promise<CloudHousehold[]>;
  createHousehold(accessToken: string, name: string, timezone?: string): Promise<CloudHousehold>;
  createInvitation(
    accessToken: string,
    householdId: string,
    role?: Exclude<CloudHouseholdRole, 'owner'>,
    maxUses?: number,
  ): Promise<InvitationResponse>;
  acceptInvitation(accessToken: string, token: string): Promise<CloudHouseholdMember>;
  updateMemberRole(
    accessToken: string,
    householdId: string,
    userId: string,
    role: Exclude<CloudHouseholdRole, 'owner'>,
  ): Promise<CloudHouseholdMember>;
  removeMember(accessToken: string, householdId: string, userId: string): Promise<void>;
  transferOwnership(accessToken: string, householdId: string, userId: string): Promise<CloudHousehold>;
}

interface ApiErrorBody {
  error?: { code?: string; message?: string; details?: unknown };
}

export class WechatRemoteSyncGateway implements CloudAccountGateway {
  constructor(private readonly apiBaseUrl: string) {
    if (!/^https:\/\//.test(apiBaseUrl)) throw new Error('云同步 API 必须使用 HTTPS');
  }

  async login(deviceId: string): Promise<LoginResponse> {
    const code = await new Promise<string>((resolve, reject) => {
      wx.login({
        success: (result: { code?: string }) => result.code ? resolve(result.code) : reject(new Error('微信登录未返回 code')),
        fail: () => reject(new Error('微信登录暂不可用')),
      });
    });
    return this.request<LoginResponse>('/v2/auth/wechat', 'POST', { code, deviceId });
  }

  async logout(accessToken: string): Promise<void> {
    await this.request('/v2/session/logout', 'POST', undefined, accessToken);
  }

  push(accessToken: string, command: SyncCommand): Promise<PushResult> {
    return this.request('/v2/sync/push', 'POST', command, accessToken);
  }

  pull(accessToken: string, householdId: string, cursor: number, limit = 200): Promise<PullPage> {
    const query = `?householdId=${encodeURIComponent(householdId)}&cursor=${cursor}&limit=${limit}`;
    return this.request(`/v2/sync/pull${query}`, 'GET', undefined, accessToken);
  }

  bootstrap(accessToken: string, householdId: string): Promise<BootstrapResponse> {
    return this.request(`/v2/bootstrap?householdId=${encodeURIComponent(householdId)}`, 'GET', undefined, accessToken);
  }

  listHouseholds(accessToken: string): Promise<CloudHousehold[]> {
    return this.request('/v2/households', 'GET', undefined, accessToken);
  }

  createHousehold(accessToken: string, name: string, timezone = 'Asia/Shanghai'): Promise<CloudHousehold> {
    return this.request('/v2/households', 'POST', { name, timezone }, accessToken);
  }

  createInvitation(
    accessToken: string,
    householdId: string,
    role: Exclude<CloudHouseholdRole, 'owner'> = 'member',
    maxUses = 1,
  ): Promise<InvitationResponse> {
    return this.request(`/v2/households/${encodeURIComponent(householdId)}/invitations`, 'POST', { role, maxUses }, accessToken);
  }

  acceptInvitation(accessToken: string, token: string): Promise<CloudHouseholdMember> {
    return this.request(`/v2/invitations/${encodeURIComponent(token)}/accept`, 'POST', undefined, accessToken);
  }

  updateMemberRole(
    accessToken: string,
    householdId: string,
    userId: string,
    role: Exclude<CloudHouseholdRole, 'owner'>,
  ): Promise<CloudHouseholdMember> {
    return this.request(
      `/v2/households/${encodeURIComponent(householdId)}/members/${encodeURIComponent(userId)}`,
      'PATCH',
      { role },
      accessToken,
    );
  }

  async removeMember(accessToken: string, householdId: string, userId: string): Promise<void> {
    await this.request(
      `/v2/households/${encodeURIComponent(householdId)}/members/${encodeURIComponent(userId)}`,
      'DELETE',
      undefined,
      accessToken,
    );
  }

  transferOwnership(accessToken: string, householdId: string, userId: string): Promise<CloudHousehold> {
    return this.request(`/v2/households/${encodeURIComponent(householdId)}/transfer-ownership`, 'POST', { userId }, accessToken);
  }

  prepareMigration(accessToken: string, householdId: string, importBatchId: string, source: string): Promise<MigrationSummary> {
    return this.request('/v2/migrations/v1/prepare', 'POST', { householdId, importBatchId, source }, accessToken);
  }

  commitMigration(accessToken: string, householdId: string, importBatchId: string, source: string): Promise<MigrationSummary> {
    return this.request('/v2/migrations/v1/commit', 'POST', { householdId, importBatchId, source }, accessToken);
  }

  private request<T>(path: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', data?: unknown, accessToken?: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      wx.request({
        url: `${this.apiBaseUrl}${path}`,
        method,
        data,
        timeout: 10_000,
        header: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
        success: (response: { statusCode: number; data: T & ApiErrorBody }) => {
          if (response.statusCode >= 200 && response.statusCode < 300) resolve(response.data);
          else reject(new RemoteApiError(
            response.data?.error?.code ?? 'REMOTE_ERROR',
            response.data?.error?.message ?? '云同步服务暂不可用',
            response.statusCode,
            response.data?.error?.details,
          ));
        },
        fail: () => reject(new RemoteApiError('NETWORK_UNAVAILABLE', '网络暂不可用，操作已保留在本机', 0)),
      });
    });
  }
}
