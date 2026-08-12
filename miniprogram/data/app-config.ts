export const appConfig = {
  // 提交审核/正式发布保持 false，避免新用户看到虚构库存。
  // 本地演示时可临时改为 true，并在开发者工具中清除缓存后重启。
  devSeed: false,
} as const;
