#!/usr/bin/env node
// Standalone overlay verifier/installer. Uses only Node built-ins on the target.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_FORMAT = 'qq-bridge-memory-overlay';
export const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

/** Only implementation files and dependency manifests belong in a code overlay. */
export function assertCodePath(relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\')
    || /[\x00-\x1f<>:"|?*]/.test(relative) || relative.startsWith('/')
    || relative.split('/').some((part) => !part || part === '.' || part === '..'
      || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) {
    throw new Error(`${relative}: 禁止的包内路径`);
  }
  const parts = relative.toLowerCase().split('/');
  const forbidden = ['state', 'data', 'roles', 'node_modules', '.git', '.dsh', 'audio', 'config.json', 'credentials', '.credentials.yaml'];
  const allowed = relative === 'package.json' || relative === 'package-lock.json'
    || /^(src|scripts|plugins)\/.+\.(?:js|mjs|cjs)$/.test(relative)
    || /^plugins\/.+\/package\.json$/.test(relative);
  if (!allowed || parts.some((part) => forbidden.includes(part))) {
    throw new Error(`${relative}: 禁止放入代码补丁（配置、状态、历史、人格及其他非代码文件不交付）`);
  }
}

// Check every existing component: a junction/symlink must not redirect a copy outside its root.
function locatedFile(root, relative) {
  let current = root;
  const parts = relative.split('/');
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.isSymbolicLink()) throw new Error(`${relative}: 路径包含链接，拒绝跨目录写入`);
    if (i < parts.length - 1 && !stat.isDirectory()) throw new Error(`${relative}: 父路径不是目录`);
    if (i === parts.length - 1 && !stat.isFile()) throw new Error(`${relative}: 目标不是普通文件`);
  }
  return current;
}

function listPayload(root, prefix = '') {
  const result = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isSymbolicLink()) throw new Error(`${relative}: 包内禁止链接`);
    if (entry.isDirectory()) result.push(...listPayload(path.join(root, entry.name), `${relative}/`));
    else if (entry.isFile()) result.push(relative);
    else throw new Error(`${relative}: 包内不是普通文件`);
  }
  return result;
}

function currentHash(file) {
  try { return sha256(fs.readFileSync(file)); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** Check the complete manifest and target before the first write; no backup, deletion or rollback. */
export function verifyUpgrade({ packageDir, targetDir, apply = false }) {
  if (!packageDir || !targetDir) throw new Error('必须指定 packageDir 和 targetDir');
  const bundle = fs.realpathSync(packageDir);
  const target = fs.realpathSync(targetDir);
  if (!fs.statSync(target).isDirectory()) throw new Error('目标根路径不是目录');
  const manifest = JSON.parse(fs.readFileSync(locatedFile(bundle, 'manifest.json'), 'utf8'));
  if (manifest.format !== PACKAGE_FORMAT || manifest.version !== 1
    || !Array.isArray(manifest.files) || !manifest.files.length) throw new Error('不支持或不完整的 manifest');
  if (!manifest.source || !/^[a-f0-9]{40,64}$/.test(manifest.source.baseline)
    || !/^[a-f0-9]{40,64}$/.test(manifest.source.revision)
    || !/^[a-f0-9]{64}$/.test(manifest.source.archiveSha256)
    || typeof manifest.source.archiveName !== 'string' || !manifest.source.archiveName) {
    throw new Error('manifest 来源信息缺失或无效');
  }
  const payload = path.join(bundle, 'payload');
  if (fs.lstatSync(payload).isSymbolicLink() || !fs.statSync(payload).isDirectory()) throw new Error('payload 必须为普通目录');
  const seen = new Set();
  for (const entry of manifest.files) {
    assertCodePath(entry.path);
    if (seen.has(entry.path.toLowerCase())) throw new Error(`${entry.path}: 清单路径重复`);
    seen.add(entry.path.toLowerCase());
    if (!/^[a-f0-9]{64}$/.test(entry.afterSha256)
      || (entry.beforeSha256 !== null && !/^[a-f0-9]{64}$/.test(entry.beforeSha256))
      || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) throw new Error(`${entry.path}: 清单哈希或长度无效`);
  }
  const actual = listPayload(payload);
  const expected = new Set(manifest.files.map((entry) => entry.path));
  for (const relative of actual) {
    if (!expected.has(relative)) throw new Error(`${relative}: 清单外文件，拒绝安装`);
  }
  if (actual.length !== expected.size) throw new Error('payload 缺少清单文件');

  const plan = [];
  const conflicts = [];
  for (const entry of manifest.files) {
    const bytes = fs.readFileSync(locatedFile(payload, entry.path));
    if (sha256(bytes) !== entry.afterSha256 || bytes.length !== entry.bytes) throw new Error(`${entry.path}: 包内哈希或长度不符`);
    const file = locatedFile(target, entry.path);
    const before = currentHash(file);
    const status = before === entry.afterSha256 ? 'already-patched'
      : before === entry.beforeSha256 ? 'ready' : 'conflict';
    if (status === 'conflict') conflicts.push(`${entry.path}: 目标冲突（实际 ${before ?? '缺失'}，基线 ${entry.beforeSha256 ?? '应不存在'}，补丁 ${entry.afterSha256}）`);
    plan.push({ entry, bytes, file, before, status });
  }
  if (conflicts.length) throw new Error(`完整检查未通过，未复制任何文件：\n${conflicts.join('\n')}`);
  const copied = [];
  if (apply) {
    try {
      for (const item of plan) {
        // Recheck immediately before each write in case the user changes a file after preflight.
        const file = locatedFile(target, item.entry.path);
        if (currentHash(file) !== item.before) throw new Error(`${item.entry.path}: 检查后目标内容发生变化`);
        if (item.status === 'already-patched') continue;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, item.bytes, { flag: item.before === null ? 'wx' : 'w' });
        copied.push(item.entry.path);
        if (currentHash(file) !== item.entry.afterSha256) throw new Error(`${item.entry.path}: 写入后哈希不符`);
      }
    } catch (error) {
      throw new Error(`复制中断；可能已有部分文件更新，不执行自动回滚。已完成：${JSON.stringify(copied)}。原因：${error.message}`);
    }
  }
  return { ok: true, applied: apply, target, sourceRevision: manifest.source.revision,
    copied, files: plan.map(({ entry, status }) => ({ path: entry.path, status })) };
}

function cli() {
  const args = process.argv.slice(2);
  const options = { packageDir: path.dirname(fileURLToPath(import.meta.url)) };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply') options.apply = true;
    else if (args[i] === '--package' || args[i] === '--target') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error('路径参数缺少值');
      options[args[i - 1] === '--package' ? 'packageDir' : 'targetDir'] = value;
    } else if (args[i] === '--help') {
      console.log('node verify-memory-package.mjs [--package 解压包目录] --target 桥接根目录 [--apply]\n默认只检查；--apply 在全部检查通过后更新代码。请先停止目标桥接和引用它的 MCP 进程。');
      return;
    } else throw new Error(`未知参数：${args[i]}`);
  }
  console.log(JSON.stringify(verifyUpgrade(options), null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { cli(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
