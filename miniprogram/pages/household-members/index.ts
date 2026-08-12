import { cloudSyncService } from '../../services/cloud/cloud-sync.service';

const roleLabels: Record<string, string> = { owner: '所有者', admin: '管理员', member: '成员', viewer: '只读成员' };

Page({
  data: {
    loading: true,
    busy: false,
    error: '',
    mode: 'guest',
    available: false,
    householdName: '未选择家庭',
    members: [] as any[],
    canManage: false,
    currentUserId: '',
    invitationToken: '',
    invitationExpiresText: '',
  },

  onShow() { this.load(); },

  load() {
    const auth = cloudSyncService.authState();
    const household = auth.households.find((item) => item.id === auth.activeHouseholdId);
    let members: any[] = [];
    try {
      members = cloudSyncService.members().map((item) => ({
        ...item,
        displayName: item.displayName || `成员 ${item.userId.slice(-6)}`,
        initial: (item.displayName || '成员').slice(0, 1),
        roleLabel: roleLabels[item.role] ?? item.role,
        isSelf: item.userId === auth.user?.id,
        manageable: item.role !== 'owner' && item.userId !== auth.user?.id,
      }));
    } catch { members = []; }
    this.setData({
      loading: false,
      mode: auth.mode,
      available: cloudSyncService.available(),
      householdName: household?.name ?? '未选择家庭',
      members,
      currentUserId: auth.user?.id ?? '',
      canManage: Boolean(household && auth.user?.id === household.ownerUserId),
    });
  },

  async createInvitation() {
    this.setData({ busy: true, error: '' });
    try {
      const result = await cloudSyncService.createInvitation('member', 1);
      const expires = new Date(result.invitation.expiresAt);
      this.setData({ busy: false, invitationToken: result.token, invitationExpiresText: `${expires.getMonth() + 1}月${expires.getDate()}日 ${String(expires.getHours()).padStart(2, '0')}:${String(expires.getMinutes()).padStart(2, '0')}` });
      wx.setClipboardData({ data: result.token });
    } catch (error) {
      this.setData({ busy: false, error: error instanceof Error ? error.message : '暂时无法创建邀请' });
    }
  },

  copyInvitation() {
    if (this.data.invitationToken) wx.setClipboardData({ data: this.data.invitationToken });
  },

  changeRole(event: any) {
    const userId = event.currentTarget.dataset.id as string;
    wx.showActionSheet({
      itemList: ['设为管理员', '设为普通成员', '设为只读成员'],
      success: (choice: { tapIndex: number }) => {
        const roles = ['admin', 'member', 'viewer'] as const;
        const role = roles[choice.tapIndex];
        if (role) void this.applyRole(userId, role);
      },
    });
  },

  async applyRole(userId: string, role: 'admin' | 'member' | 'viewer') {
    this.setData({ busy: true, error: '' });
    try { await cloudSyncService.updateMemberRole(userId, role); this.setData({ busy: false }); this.load(); }
    catch (error) { this.setData({ busy: false, error: error instanceof Error ? error.message : '无法调整角色' }); }
  },

  removeMember(event: any) {
    const userId = event.currentTarget.dataset.id as string;
    const name = event.currentTarget.dataset.name as string;
    wx.showModal({
      title: `移除${name}？`,
      content: '移除后，该成员设备中尚未同步的操作会被永久拒绝；已经同步的家庭记录会保留操作者审计信息。',
      confirmText: '确认移除',
      confirmColor: '#D96B62',
      success: (choice: { confirm: boolean }) => { if (choice.confirm) void this.confirmRemove(userId); },
    });
  },

  async confirmRemove(userId: string) {
    this.setData({ busy: true, error: '' });
    try { await cloudSyncService.removeMember(userId); this.setData({ busy: false }); this.load(); }
    catch (error) { this.setData({ busy: false, error: error instanceof Error ? error.message : '无法移除成员' }); }
  },

  transferOwnership(event: any) {
    const userId = event.currentTarget.dataset.id as string;
    const name = event.currentTarget.dataset.name as string;
    wx.showModal({
      title: `把家庭交给${name}？`,
      content: '确认后对方成为唯一所有者，你将变为普通成员。该操作会写入审计记录。',
      confirmText: '转移所有权',
      confirmColor: '#D96B62',
      success: (choice: { confirm: boolean }) => { if (choice.confirm) void this.confirmTransfer(userId); },
    });
  },

  async confirmTransfer(userId: string) {
    this.setData({ busy: true, error: '' });
    try { await cloudSyncService.transferOwnership(userId); this.setData({ busy: false }); this.load(); }
    catch (error) { this.setData({ busy: false, error: error instanceof Error ? error.message : '无法转移所有权' }); }
  },

  onShareAppMessage() {
    const token = this.data.invitationToken;
    return {
      title: `邀请你加入“${this.data.householdName}”一起管理冰箱`,
      path: token ? `/pages/households/index?invite=${encodeURIComponent(token)}` : '/pages/households/index',
    };
  },
});
