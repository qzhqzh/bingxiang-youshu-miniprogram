import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mini = join(root, 'miniprogram');
const config = JSON.parse(readFileSync(join(mini, 'app.json'), 'utf8'));
const projectConfig = JSON.parse(readFileSync(join(root, 'project.config.json'), 'utf8'));
assert.equal(projectConfig.miniprogramRoot, 'miniprogram/', 'miniprogramRoot 配置错误');
assert.ok(projectConfig.setting?.useCompilerPlugins?.includes('typescript'), '未启用微信开发者工具 TypeScript 编译插件');
assert.equal(projectConfig.projectname, '冰箱有数', 'project.config.json 品牌名未更新');
assert.equal(config.window?.navigationBarTitleText, '冰箱有数', 'app.json 品牌名未更新');
assert.ok(existsSync(join(mini, 'assets/png/app-logo-v2.png')), '缺少冰箱有数新版图标');

for (const page of config.pages) {
  for (const extension of ['.ts', '.json', '.wxml', '.wxss']) {
    assert.ok(existsSync(join(mini, `${page}${extension}`)), `缺少页面文件 ${page}${extension}`);
  }
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const files = walk(mini);
for (const path of files.filter((item) => item.endsWith('.json'))) {
  JSON.parse(readFileSync(path, 'utf8'));
}

const allowedWxmlTags = new Set(['view', 'text', 'image', 'button', 'input', 'picker', 'textarea', 'scroll-view', 'block', 'freshness-badge', 'empty-state']);
for (const path of files.filter((item) => item.endsWith('.wxml'))) {
  const source = readFileSync(path, 'utf8');
  assert.ok(!/<[\w-]+\b(?=[^>]*\bwx:if=)(?=[^>]*\bwx:for=)[^>]*>/s.test(source), `WXML 不应在同一节点混用 wx:if 与 wx:for，请用 block 分组: ${path}`);
  const stack = [];
  const tagPattern = /<\/?([a-zA-Z][\w-]*)(?:\s[^<>]*?)?\/?\s*>/g;
  for (const match of source.matchAll(tagPattern)) {
    const full = match[0];
    const name = match[1];
    assert.ok(allowedWxmlTags.has(name), `WXML 使用了不支持的标签 <${name}>: ${path}`);
    if (full.startsWith('</')) assert.equal(stack.pop(), name, `WXML 标签闭合错误: ${path}`);
    else if (!full.endsWith('/>')) stack.push(name);
  }
  assert.equal(stack.length, 0, `WXML 存在未闭合标签: ${path}`);
}
const pageTs = files.filter((path) => path.includes(`${join(mini, 'pages')}`) && path.endsWith('.ts'));
for (const path of pageTs) {
  const source = readFileSync(path, 'utf8');
  assert.ok(!/wx\.(get|set|remove|clear)Storage/.test(source), `页面禁止直接操作 storage: ${path}`);
}
for (const path of files.filter((item) => item.endsWith('.ts') && !item.includes(`${join(mini, 'repositories', 'local')}`))) {
  const source = readFileSync(path, 'utf8');
  assert.ok(!/wx\.(get|set|remove|clear)Storage/.test(source), `只有 LocalRepository 可操作 storage: ${path}`);
}

for (const path of files.filter((item) => item.endsWith('.wxml') || item.endsWith('.ts'))) {
  const source = readFileSync(path, 'utf8');
  const assetPaths = [...source.matchAll(/['"](\/assets\/[^'"}]+)['"]/g)].map((match) => match[1]);
  for (const asset of assetPaths) assert.ok(existsSync(join(mini, asset.slice(1))), `缺少视觉资源 ${asset}`);
}

assert.ok(readFileSync(join(mini, 'repositories/types.ts'), 'utf8').includes('interface CloudRepository'), '缺少 CloudRepository 接口');
assert.ok(readFileSync(join(mini, 'repositories/local/local-app.repository.ts'), 'utf8').includes('wx.setStorageSync'), 'LocalRepository 未持久化');
assert.ok(readFileSync(join(mini, 'domain/rules.ts'), 'utf8').includes('previewCooking'), '缺少可单测的做菜预览规则');

console.log(`静态检查通过：${config.pages.length} 个页面，${pageTs.length} 个页面控制器，${files.length} 个小程序文件；JSON/WXML/资源/Repository 边界均有效。`);
