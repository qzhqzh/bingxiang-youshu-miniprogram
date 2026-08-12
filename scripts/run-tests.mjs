import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'tests-build');

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
  return result.status === 0;
}

rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
writeFileSync(join(output, 'package.json'), '{ "type": "commonjs", "private": true }\n');

try {
  const compiled = run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.test.json']);
  if (compiled) {
    run(process.execPath, [
      '--test',
      join(output, 'tests/domain.test.js'),
      join(output, 'tests/service.test.js'),
    ]);
  }
} finally {
  rmSync(output, { recursive: true, force: true });
}
