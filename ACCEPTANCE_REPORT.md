# 冰箱有数 MVP 验收报告

## 规格逐项结论

| 需求 | 状态 | 证据 |
|---|---|---|
| 微信原生、TypeScript、无 React/Vue/Taro/uni-app | 通过 | `miniprogram/**/*.ts`、WXML/WXSS 与 `project.config.json` TypeScript 编译插件 |
| 首版纯本地、不登录、不依赖后端 | 通过 | 发布检查未发现 login/request/cloud；只有 LocalRepository 使用 Storage |
| 页面禁止直接操作 Storage | 通过 | `scripts/static-check.mjs` 强制扫描；9 个页面控制器通过 |
| 预留 CloudRepository | 通过 | `repositories/types.ts` 和 `repositories/cloud/cloud-app.repository.ts` |
| 核心逻辑为纯 TypeScript 且可测试 | 通过 | `domain/rules.ts`；11 套件/15 场景全部通过 |
| 9 个指定页面 | 通过 | `app.json` 注册 9 页且每页 TS/JSON/WXML/WXSS 齐备 |
| 首页库存数、优先食材、食谱排序 | 通过 | `AppService.home` 与 recipeRank |
| 批次库存与食材聚合 | 通过 | `aggregateInventory`、仓库/详情页、多批次测试 |
| freshness 四状态动态计算 | 通过 | `calculateFreshness` 边界测试与 UI 文案；无“已变质”文案 |
| locked/unlockable/mastered | 通过 | 三类 unlockRule；主动 unlock 门槛；只有 mastered 可做菜 |
| availability | 通过 | 必选配料计数、可选缺料不阻塞、missing 精确测试 |
| FEFO 跨批次预览后提交 | 通过 | `previewCooking`/`completeCooking`；到期日/购入日/创建时间顺序 |
| CookingRecord 和进度更新 | 通过 | 领域测试与 service 闭环测试 |
| 购物缺料与转购入 | 通过 | `addRecipeMissing`、购物页预填、购入后勾选测试 |
| seed 与本地资源 | 通过 | 30 种食材、10 道食谱、50 个 PNG；引用完整性测试 |
| 空/加载/错误状态 | 通过 | 主要数据页均有对应分支或组件 |
| 我的统计/设置/导出/清空/关于 | 通过 | profile 页面与 service |
| 官方开发者工具导入与编译 | 通过 | RC 2.02.2607271 + 内置测试号；普通编译 0 个问题，核心页面和购入闭环冒烟通过 |
| 真实 AppID 正式门禁与编译 | 通过 | `wxc62caa8eb9379ed4`；正式发布检查通过，重新加载后模拟器编译 0 个问题，上传入口可进入 |
| 开发版本上传 | 通过 | 版本 `1.0.0` 已于 2026-08-12 通过官方微信开发者工具上传成功 |
| 可提交审核工程准备 | 条件通过 | 正式配置/发布预检/审核文案/隐私底稿和开发版本上传已完成；管理员设置体验版、主体/类目/隐私配置与提审仍是外部条件 |
| “冰箱有数”品牌升级 | 通过 | 名称、项目介绍、新冰箱图标、深绿/鼠尾草绿/奶油/暖橙视觉、首页与“我的”页、分享文案及提审底稿已统一；1.1.0 门禁和开发者工具渲染通过 |
| 品牌升级的数据兼容 | 通过 | 保留 `pantry:v1:*` Storage key，既有 1.0 本地库存和记录可继续读取 |

## 当前唯一外部门槛

代码和真实 AppID 配置均已达到提审前工程条件，并已用官方开发者工具完成导入、编译、核心流程冒烟及版本 `1.0.0` 上传。开发者工具明确提示上传后需要管理员在后台设置体验版；主体、备案、服务类目与隐私指引仍需在微信公众平台确认后才能提审。

在这些外部条件到位前，不应声称已经“上线”。完整操作见 `RELEASE_CHECKLIST.md`。
