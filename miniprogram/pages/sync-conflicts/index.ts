import { cloudSyncService } from '../../services/cloud/cloud-sync.service';
import type { LocalConflict } from '../../v2/models';

const commandLabels: Record<string, string> = {
  PurchaseBatch: '购入食材',
  CompleteCooking: '完成做菜',
  AddShoppingItem: '添加购物项',
  CheckShoppingItem: '更新购物项',
  RemoveShoppingItem: '删除购物项',
  DiscardBatch: '丢弃食材',
  UnlockRecipe: '解锁食谱',
  UpdatePreferences: '更新偏好',
};

const typeLabels: Record<LocalConflict['type'], string> = {
  INVENTORY_CONFLICT: '库存已经变化',
  VERSION_CONFLICT: '内容已被其他成员更新',
  MEMBERSHIP_CHANGED: '家庭成员权限已变化',
  MUTATION_REJECTED: '服务端拒绝了这次操作',
};

Page({
  data: {
    loading: true,
    error: '',
    conflicts: [] as any[],
  },

  onShow() { this.load(); },

  load() {
    try {
      const conflicts = cloudSyncService.conflicts().map((item) => ({
        ...item,
        commandLabel: commandLabels[item.command] ?? item.command,
        typeLabel: typeLabels[item.type],
        timeText: this.formatTime(item.createdAt),
        retryable: item.type !== 'MEMBERSHIP_CHANGED',
        serverSummary: this.serverSummary(item.serverValue),
      }));
      this.setData({ loading: false, error: '', conflicts });
    } catch (error) {
      this.setData({ loading: false, error: error instanceof Error ? error.message : '无法读取同步冲突' });
    }
  },

  formatTime(timestamp: number): string {
    const date = new Date(timestamp);
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  },

  serverSummary(value: unknown): string {
    if (value === undefined) return '';
    try {
      const serialized = typeof value === 'string' ? value : JSON.stringify(value);
      return serialized.length > 160 ? `${serialized.slice(0, 157)}…` : serialized;
    } catch { return '服务端返回了无法展示的详情'; }
  },

  retry(event: any) {
    const id = event.currentTarget.dataset.id as string;
    wx.showModal({
      title: '重新加入同步队列？',
      content: '系统会在下次同步时根据家庭的最新数据重新提交。库存仍不足时会再次要求你确认，不会强行扣成负数。',
      confirmText: '重新提交',
      confirmColor: '#24564A',
      success: (choice: { confirm: boolean }) => {
        if (!choice.confirm) return;
        try { cloudSyncService.retryConflict(id); this.load(); wx.showToast({ title: '已重新排队', icon: 'success' }); }
        catch (error) { wx.showToast({ title: error instanceof Error ? error.message : '无法重试', icon: 'none' }); }
      },
    });
  },

  cancel(event: any) {
    const id = event.currentTarget.dataset.id as string;
    wx.showModal({
      title: '取消这次本机操作？',
      content: '对应的待同步操作会从本机队列删除，家庭云端数据不会改变。此操作不会删除已经同步成功的记录。',
      confirmText: '确认取消',
      confirmColor: '#D96B62',
      success: (choice: { confirm: boolean }) => {
        if (!choice.confirm) return;
        try { cloudSyncService.cancelConflict(id); this.load(); wx.showToast({ title: '已取消', icon: 'success' }); }
        catch (error) { wx.showToast({ title: error instanceof Error ? error.message : '无法取消', icon: 'none' }); }
      },
    });
  },
});
