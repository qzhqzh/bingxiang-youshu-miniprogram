import { cloudSyncService } from '../../services/cloud/cloud-sync.service';
import { RemoteApiError } from '../../services/cloud/remote-sync.gateway';
import type { CloudAccountDeletionRequest, CloudDataExportArtifact } from '../../v2/models';

Page({
  data: {
    loading: true,
    busy: false,
    error: '',
    mode: 'guest',
    available: false,
    confirmation: '',
    exportId: '',
    exportExpiresText: '',
    exportSource: '',
    deletion: null as CloudAccountDeletionRequest | null,
    deletionPending: false,
    deletionExecuteText: '',
  },

  onShow() { void this.load(); },

  async load() {
    const auth = cloudSyncService.authState();
    this.setData({ loading: false, mode: auth.mode, available: cloudSyncService.available(), error: '' });
    if (auth.mode !== 'cloud' || !cloudSyncService.available()) return;
    try {
      const deletion = await cloudSyncService.accountDeletionStatus();
      this.setDeletion(deletion);
    } catch (error) {
      if (!(error instanceof RemoteApiError && error.code === 'NOT_FOUND')) {
        this.setData({ error: error instanceof Error ? error.message : '暂时无法读取账号状态' });
      }
    }
  },

  inputConfirmation(event: { detail: { value: string } }) {
    this.setData({ confirmation: event.detail.value });
  },

  createExport() {
    wx.showModal({
      title: '导出云端个人数据？',
      content: '将生成当前账号有权读取的家庭共享数据和本人设置，不包含微信身份标识、会话密钥、设备指纹、邀请口令或其他成员个人偏好。导出内容会复制到剪贴板，请妥善保管。',
      confirmText: '生成导出',
      confirmColor: '#24564A',
      success: (choice: { confirm: boolean }) => { if (choice.confirm) void this.confirmExport(); },
    });
  },

  async confirmExport() {
    this.setData({ busy: true, error: '' });
    try {
      const artifact = await cloudSyncService.createDataExport();
      const source = JSON.stringify(artifact.payload, null, 2);
      this.setExport(artifact, source);
      wx.setClipboardData({ data: source });
    } catch (error) {
      this.setData({ busy: false, error: error instanceof Error ? error.message : '暂时无法导出' });
    }
  },

  copyExport() {
    if (this.data.exportSource) wx.setClipboardData({ data: this.data.exportSource });
  },

  requestDeletion() {
    if (this.data.confirmation !== '注销账号') {
      this.setData({ error: '请完整输入“注销账号”后再继续' });
      return;
    }
    wx.showModal({
      title: '确认申请注销？',
      content: '你拥有的家庭必须先转移或删除。申请后其他设备立即退出，当前设备只保留查看/取消申请的权限；冷静期结束后删除微信身份映射和个人设置，共享做菜与库存审计会以“已注销成员”保留。',
      confirmText: '申请注销',
      confirmColor: '#D96B62',
      success: (choice: { confirm: boolean }) => { if (choice.confirm) void this.confirmDeletion(); },
    });
  },

  async confirmDeletion() {
    this.setData({ busy: true, error: '' });
    try {
      const deletion = await cloudSyncService.requestAccountDeletion(this.data.confirmation);
      this.setDeletion(deletion);
      this.setData({ busy: false, confirmation: '' });
    } catch (error) {
      this.setData({ busy: false, error: error instanceof Error ? error.message : '暂时无法申请注销' });
    }
  },

  cancelDeletion() {
    wx.showModal({
      title: '取消账号注销？',
      content: '取消后当前设备恢复使用；此前已经撤销的其他设备会话仍需重新登录。',
      confirmText: '取消注销',
      confirmColor: '#24564A',
      success: (choice: { confirm: boolean }) => { if (choice.confirm) void this.confirmCancelDeletion(); },
    });
  },

  async confirmCancelDeletion() {
    this.setData({ busy: true, error: '' });
    try {
      const deletion = await cloudSyncService.cancelAccountDeletion();
      this.setDeletion(deletion);
      this.setData({ busy: false });
      wx.showToast({ title: '已取消注销', icon: 'success' });
    } catch (error) {
      this.setData({ busy: false, error: error instanceof Error ? error.message : '暂时无法取消注销' });
    }
  },

  setExport(artifact: CloudDataExportArtifact, source: string) {
    this.setData({
      busy: false,
      exportId: artifact.id,
      exportExpiresText: this.formatTime(artifact.expiresAt),
      exportSource: source,
    });
  },

  setDeletion(deletion: CloudAccountDeletionRequest) {
    this.setData({
      deletion,
      deletionPending: deletion.status === 'pending',
      deletionExecuteText: this.formatTime(deletion.executeAfter),
    });
  },

  formatTime(timestamp: number): string {
    const date = new Date(timestamp);
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  },
});
