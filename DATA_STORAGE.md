# 冰箱有数数据存储说明

## 当前数据存在哪里

当前版本的业务数据全部保存在**用户当前设备上的微信小程序本地存储空间**，由微信的 `wx.setStorageSync` / `wx.getStorageSync` 提供。它们不在代码仓库里、不在开发者电脑的项目目录里，也不会发送到任何后端或云数据库。

- 真机使用：保存在该手机微信客户端为 AppID `wxc62caa8eb9379ed4` 分配的本地小程序存储空间。
- 微信开发者工具：保存在开发者工具为该 AppID 和当前调试环境维护的本地缓存中。
- 换手机、卸载微信、清理小程序数据或清除开发者工具缓存后，数据可能丢失。
- 当前不登录、没有用户账号映射、没有多设备同步或家庭共享。

唯一直接访问微信 Storage 的实现是：

`miniprogram/repositories/local/local-app.repository.ts`

页面不会直接操作 Storage，而是通过 `AppService` 和 `AppRepository` 访问。未来接入云端时，可实现已预留的 `CloudAppRepository`，无需把页面改成直接调用后端。

## Storage key

为兼容已经上传和测试过的 1.0 数据，品牌升级后继续保留 `pantry:v1:*` key，不进行破坏性改名：

| Key | 内容 |
|---|---|
| `pantry:v1:ingredients` | 食材基础目录 |
| `pantry:v1:batches` | 用户购入的食材批次与剩余数量 |
| `pantry:v1:recipes` | 食谱基础目录 |
| `pantry:v1:recipeProgress` | 食谱锁定、可解锁、已掌握状态及做菜次数 |
| `pantry:v1:cookingRecords` | 每次做菜记录与实际批次扣减明细 |
| `pantry:v1:shoppingList` | 购物清单 |
| `pantry:v1:settings` | 新鲜度提醒天数、默认保存方式等偏好 |
| `pantry:v1:meta` | 本地数据版本与初始化信息 |
| `pantry:v1:importBackup` | 最近一次 JSON 导入前的完整本地备份；不包含在普通业务快照中 |

`miniprogram/data/ingredients.ts` 和 `miniprogram/data/recipes.ts` 是随代码发布的基础 seed；首次启动时会由 Repository 写入本地 Storage。用户自己的库存、记录和设置不会写回源码或 Git 仓库。

## 用户如何导出或删除

- “我的 → 导出 JSON”会读取当前完整快照并复制到系统剪贴板；后续保存位置由用户决定。
- “我的 → 导入 JSON”会先校验结构、ID 和引用关系，确认后把当前快照保存为 `importBackup` 再替换数据。
- “我的 → 恢复导入前数据”会恢复最近备份，同时把恢复前的数据保存成新的回退备份。
- “我的 → 清空全部数据”会删除上述 `pantry:v1:*` key 和导入备份，再重新初始化基础食材和食谱。
- 当前没有自动备份。正式推广前若要支持换机和家庭共享，应新增登录、云同步、隐私说明、数据迁移和冲突处理，不能只把本地 key 直接上传。详细待开发方案见 [V2_MULTI_USER_SYNC_DESIGN.md](./V2_MULTI_USER_SYNC_DESIGN.md)。
