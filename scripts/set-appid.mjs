import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const appid = process.argv[2]?.trim();
if (!appid || !/^wx[a-zA-Z0-9]{16}$/.test(appid)) {
  console.error('用法：node scripts/set-appid.mjs wx1234567890abcdef');
  console.error('请传入以 wx 开头、后接 16 位字母或数字的真实小程序 AppID。');
  process.exit(1);
}

const path = resolve(root, 'project.config.json');
const config = JSON.parse(readFileSync(path, 'utf8'));
config.appid = appid;
writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
console.log(`已写入 AppID：${appid}`);
