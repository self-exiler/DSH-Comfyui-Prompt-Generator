/**
 * 语法自检：把所有 .js 当作 ES Module 交给 Node 解析。
 * 用于在没有打包器的情况下拦住 import/语法错误（WebView 里出错代价更高）。
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules']);

async function collect(dir, output = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await collect(full, output);
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) output.push(full);
  }
  return output;
}

const files = (await collect(ROOT)).sort();
let failed = 0;

for (const file of files) {
  const source = await readFile(file);
  try {
    execFileSync(process.execPath, ['--input-type=module', '--check'], { input: source });
  } catch (error) {
    failed += 1;
    console.error(`✗ ${path.relative(ROOT, file)}`);
    console.error(String(error.stderr ?? error.message));
  }
}

console.log(`语法检查完成：${files.length - failed}/${files.length} 通过`);
if (failed) process.exit(1);
