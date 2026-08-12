import { cloudSyncService } from '../../services/cloud/cloud-sync.service';

Page({
  data: {
    loading: true,
    busy: false,
    error: '',
    mode: 'guest',
    available: false,
    households: [] as any[],
    activeHouseholdId: '',
    newHouseholdName: '',
    invitationToken: '',
  },

  onLoad(options: Record<string, string>) {
    if (options.invite) this.setData({ invitationToken: options.invite });
  },

  onShow() { this.load(); },

  load() {
    const auth = cloudSyncService.authState();
    this.setData({
      loading: false,
      mode: auth.mode,
      available: cloudSyncService.available(),
      households: auth.households.map((item) => ({ ...item, selected: item.id === auth.activeHouseholdId })),
      activeHouseholdId: auth.activeHouseholdId ?? '',
    });
  },

  onNameInput(event: any) { this.setData({ newHouseholdName: event.detail.value }); },
  onTokenInput(event: any) { this.setData({ invitationToken: event.detail.value }); },

  async switchHousehold(event: any) {
    const id = event.currentTarget.dataset.id as string;
    if (id === this.data.activeHouseholdId || this.data.busy) return;
    this.setData({ busy: true, error: '' });
    try {
      await cloudSyncService.switchHousehold(id);
      this.setData({ busy: false });
      this.load();
      wx.showToast({ title: '已切换家庭', icon: 'success' });
    } catch (error) {
      this.setData({ busy: false, error: error instanceof Error ? error.message : '暂时无法切换家庭' });
    }
  },

  async createHousehold() {
    const name = String(this.data.newHouseholdName).trim();
    if (!name || name.length > 30) { wx.showToast({ title: '请输入 1–30 个字的名称', icon: 'none' }); return; }
    this.setData({ busy: true, error: '' });
    try {
      await cloudSyncService.createHousehold(name);
      this.setData({ busy: false, newHouseholdName: '' });
      this.load();
      wx.showToast({ title: '家庭已创建', icon: 'success' });
    } catch (error) {
      this.setData({ busy: false, error: error instanceof Error ? error.message : '暂时无法创建家庭' });
    }
  },

  async acceptInvitation() {
    const token = String(this.data.invitationToken).trim();
    if (!token) { wx.showToast({ title: '请粘贴邀请口令', icon: 'none' }); return; }
    this.setData({ busy: true, error: '' });
    try {
      await cloudSyncService.acceptInvitation(token);
      this.setData({ busy: false, invitationToken: '' });
      this.load();
      wx.showToast({ title: '已加入家庭', icon: 'success' });
    } catch (error) {
      this.setData({ busy: false, error: error instanceof Error ? error.message : '邀请口令无效或已过期' });
    }
  },

  openMembers() { wx.navigateTo({ url: '/pages/household-members/index' }); },
  backToCloud() { wx.navigateBack(); },
});
