#!/usr/bin/env node
// Export committed changes as a portable directory. No runtime state or dependency tree is copied.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertCodePath, PACKAGE_FORMAT, sha256 } from './verify-memory-package.mjs';

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0 || result.error) throw new Error(`git ${args[0]} 失败：${result.error?.message || result.stderr?.toString('utf8')}`);
  return result.stdout;
}

function resolveCommit(root, ref) {
  return git(root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).toString('utf8').trim();
}

function blob(root, revision, relative) {
  const tree = git(root, ['ls-tree', '-z', revision, '--', relative]).toString('utf8');
  if (!tree) return null;
  if (!/^100(?:644|755) blob /.test(tree)) throw new Error(`${relative}: 只交付普通文件，禁止链接或目录`);
  return git(root, ['show', `${revision}:${relative}`]);
}

// The final directory is new, so resolve its nearest existing ancestor first.
// This accounts for Windows casing aliases and junctions before checking containment.
function canonicalNewPath(value) {
  let ancestor = path.resolve(value);
  const missing = [];
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error(`找不到输出目录的已存在祖先：${value}`);
    missing.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  return path.join(fs.realpathSync.native(ancestor), ...missing);
}

/** Uses Git blobs byte-for-byte, including original Windows line endings in this baseline. */
export function packageUpgrade({ repositoryRoot, baselineRef = '78e61d1', revisionRef = 'HEAD',
  outputDir, sourceArchive, readmePath }) {
  if (!repositoryRoot || !outputDir || !sourceArchive) throw new Error('必须指定源码目录、输出目录和原 ZIP 路径');
  const root = fs.realpathSync.native(repositoryRoot);
  const output = canonicalNewPath(outputDir);
  if (fs.existsSync(output)) throw new Error(`输出已存在，拒绝混入旧文件：${output}`);
  const relativeOutput = path.relative(root, output);
  if (!relativeOutput || (!path.isAbsolute(relativeOutput) && relativeOutput !== '..' && !relativeOutput.startsWith('..' + path.sep))) {
    throw new Error('交付输出必须放在源码目录之外');
  }
  const baseline = resolveCommit(root, baselineRef);
  const revision = resolveCommit(root, revisionRef);
  const parts = git(root, ['diff', '--name-status', '-z', '--no-renames', baseline, revision]).toString('utf8').split('\0');
  const changed = [];
  for (let i = 0; i < parts.length - 1; i += 2) {
    const [status, relative] = parts.slice(i, i + 2);
    assertCodePath(relative);
    if (status !== 'A' && status !== 'M') throw new Error(`${relative}: 不支持 ${status}；本交付不删除或重命名目标文件`);
    changed.push(relative);
  }
  if (!changed.length) throw new Error('没有已提交的代码变更可打包');
  // Keep the dependency manifest and lock together, even when this stage adds no dependency.
  const files = [...new Set([...changed, 'package.json', 'package-lock.json'])].sort();
  const payload = files.map((relative) => {
    assertCodePath(relative);
    const after = blob(root, revision, relative);
    if (after === null) throw new Error(`${relative}: 待交付提交缺少必需文件`);
    const before = blob(root, baseline, relative);
    return { relative, after, entry: { path: relative, beforeSha256: before === null ? null : sha256(before),
      afterSha256: sha256(after), bytes: after.length } };
  });
  const verifier = blob(root, revision, 'scripts/verify-memory-package.mjs');
  if (!verifier) throw new Error('待交付提交必须包含 scripts/verify-memory-package.mjs');
  const sourceBytes = fs.readFileSync(sourceArchive);
  const manifest = {
    format: PACKAGE_FORMAT, version: 1,
    source: { archiveName: path.basename(sourceArchive), archiveSha256: sha256(sourceBytes), baseline, revision },
    files: payload.map(({ entry }) => entry)
  };
  // Everything is read and validated before creating the output; no production paths are written.
  const readme = readmePath ? fs.readFileSync(readmePath) : null;
  fs.mkdirSync(output, { recursive: true });
  for (const file of payload) {
    const destination = path.join(output, 'payload', file.relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, file.after, { flag: 'wx' });
  }
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  fs.writeFileSync(path.join(output, 'verify-memory-package.mjs'), verifier, { flag: 'wx' });
  if (readme) fs.writeFileSync(path.join(output, 'README-MIGRATION.md'), readme, { flag: 'wx' });
  return { output, source: manifest.source, fileCount: payload.length,
    payloadBytes: payload.reduce((sum, file) => sum + file.after.length, 0) };
}

function cli() {
  const options = { repositoryRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') };
  const keys = { '--repo': 'repositoryRoot', '--baseline': 'baselineRef', '--revision': 'revisionRef',
    '--output': 'outputDir', '--source-archive': 'sourceArchive', '--readme': 'readmePath' };
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help') {
      console.log('node scripts/package-memory-upgrade.mjs --source-archive 原ZIP --output 新交付目录 [--baseline 78e61d1] [--revision HEAD] [--readme README-MIGRATION.md]\n只导出已提交的源码；输出目录可压缩后传输，目标仅需 Node.js。');
      return;
    }
    const key = keys[args[i]];
    const value = args[++i];
    if (!key || !value || value.startsWith('--')) throw new Error('未知参数或缺少参数值');
    options[key] = value;
  }
  console.log(JSON.stringify(packageUpgrade(options), null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { cli(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
