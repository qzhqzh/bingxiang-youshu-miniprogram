import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ignoredDirectories = new Set(['.git', 'node_modules', 'server-dist', 'tests-build', 'coverage']);
const textExtensions = new Set(['.ts', '.js', '.mjs', '.json', '.md', '.yaml', '.yml', '.sql', '.wxml', '.wxss']);
const forbiddenFileNames = [/^\.env(?:\..+)?$/i, /^(?:id_rsa|id_ed25519)$/i, /\.(?:pem|key|p12|pfx)$/i];

function textFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return ignoredDirectories.has(entry.name) ? [] : textFiles(join(directory, entry.name));
    const path = join(directory, entry.name);
    const rel = relative(root, path).replaceAll('\\', '/');
    if (rel === '.env.example') return [path];
    assert.ok(!forbiddenFileNames.some((pattern) => pattern.test(entry.name)), `仓库中存在不应提交的密钥/环境文件：${rel}`);
    return textExtensions.has(extname(entry.name).toLowerCase()) ? [path] : [];
  });
}

const patterns = [
  { name: '私钥正文', value: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'GitHub token', value: /\bgh[opusr]_[A-Za-z0-9]{30,}\b/ },
  { name: '带口令的 PostgreSQL URL', value: /postgres(?:ql)?:\/\/[^\s/:]+:[^\s@]+@/i },
  { name: '已填写的微信 AppSecret 环境值', value: /^BINGXIANG_WECHAT_APP_SECRET[ \t]*=[ \t]*\S+/m },
  { name: '已填写的数据库连接环境值', value: /^BINGXIANG_DATABASE_URL[ \t]*=[ \t]*\S+/m },
];

let checked = 0;
for (const path of textFiles(root)) {
  const rel = relative(root, path).replaceAll('\\', '/');
  const source = readFileSync(path, 'utf8');
  for (const pattern of patterns) {
    assert.ok(!pattern.value.test(source), `疑似${pattern.name}：${rel}`);
  }
  checked += 1;
}

console.log(`密钥检查通过：扫描 ${checked} 个文本文件，未发现私钥、已填写服务端环境值或常见访问令牌。`);
