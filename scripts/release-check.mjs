import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mini = join(root, 'miniprogram');
const allowPlaceholder = process.argv.includes('--allow-placeholder');
const project = JSON.parse(readFileSync(join(root, 'project.config.json'), 'utf8'));
const appJson = JSON.parse(readFileSync(join(mini, 'app.json'), 'utf8'));

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

if (project.appid === 'touristappid') {
  assert.ok(allowPlaceholder, '仍是 touristappid；请先执行 node scripts/set-appid.mjs <真实AppID>');
} else {
  assert.match(project.appid, /^wx[a-zA-Z0-9]{16}$/, 'project.config.json 中的 AppID 格式无效');
}

const appConfig = readFileSync(join(mini, 'data', 'app-config.ts'), 'utf8');
assert.match(appConfig, /devSeed:\s*false/, '正式提审前必须关闭 devSeed');
assert.match(appConfig, /cloudSyncEnabled:\s*false/, '2.0 云端尚未部署完成，当前提审包必须关闭 cloudSyncEnabled');
assert.match(appConfig, /apiBaseUrl:\s*['"]['"]/, '未部署前不得在提审包写入占位 API 域名');
assert.equal(project.projectname, '冰箱有数', '发布工程名称必须使用当前品牌“冰箱有数”');
assert.equal(appJson.window?.navigationBarTitleText, '冰箱有数', '全局导航标题必须使用当前品牌“冰箱有数”');

const files = walk(mini);
const totalBytes = files.reduce((total, path) => total + statSync(path).size, 0);
assert.ok(totalBytes < 2 * 1024 * 1024, `主包体积 ${totalBytes} 字节，超过 2 MiB 检查线`);

const typeScriptFiles = files.filter((path) => path.endsWith('.ts'));
const source = typeScriptFiles.map((path) => readFileSync(path, 'utf8')).join('\n');
for (const api of ['wx.getUserProfile', 'wx.uploadFile', 'wx.cloud']) {
  assert.ok(!source.includes(api), `纯本地首版不应调用 ${api}`);
}
for (const path of typeScriptFiles.filter((item) => !item.endsWith(join('services', 'cloud', 'remote-sync.gateway.ts')))) {
  const fileSource = readFileSync(path, 'utf8');
  assert.ok(!fileSource.includes('wx.login') && !fileSource.includes('wx.request'), `登录/网络调用只能位于 RemoteSyncGateway: ${path}`);
}

console.log(`发布检查通过：品牌=冰箱有数，AppID=${project.appid}，devSeed=false，cloudSyncEnabled=false，主包约 ${(totalBytes / 1024).toFixed(1)} KiB；登录/网络实现已隔离且当前关闭。`);
if (project.appid === 'touristappid') console.log('当前仅剩外部事项：替换真实 AppID，并由有权限的微信账号完成上传与提审。');
