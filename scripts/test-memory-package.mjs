import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
async function modules() {
  assert.ok(fs.existsSync(path.join(scriptsDir, 'package-memory-upgrade.mjs')), '打包脚本必须实现');
  assert.ok(fs.existsSync(path.join(scriptsDir, 'verify-memory-package.mjs')), '校验脚本必须实现');
  return {
    ...(await import('./package-memory-upgrade.mjs')),
    ...(await import('./verify-memory-package.mjs'))
  };
}

function write(root, name, value) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

function git(root, ...args) {
  const result = spawnSync('git', args, {
    cwd: root, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, GIT_AUTHOR_NAME: 'Package Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Package Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' }
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture(t) {
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'qq-memory-package-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), parent);
    assert.ok(path.basename(root).startsWith('qq-memory-package-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const repo = path.join(root, 'source repo');
  const target = path.join(root, '另一台服务器', 'custom bridge');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(target, { recursive: true });
  const original = {
    'src/example.js': 'export const revision = 1;\r\n',
    'package.json': '{"name":"fixture","type":"module"}\n',
    'package-lock.json': '{"name":"fixture","lockfileVersion":3}\n',
    'config.json': '{"token":"synthetic-token-do-not-copy"}\n',
    'state/social-v2.json': '{"existingMemory":true}\n',
    'data/日记/diary.jsonl': '{"syntheticDiary":true}\n',
    'roles/persona.md': 'synthetic persona\n'
  };
  for (const [name, value] of Object.entries(original)) {
    write(repo, name, value);
    write(target, name, value);
  }
  git(repo, 'init', '--quiet');
  git(repo, 'config', 'core.autocrlf', 'false');
  // The fixture commits only synthetic source/config data; persona is deliberately untracked.
  git(repo, 'add', 'src/example.js', 'package.json', 'package-lock.json', 'config.json', 'state/social-v2.json', 'data/日记/diary.jsonl');
  git(repo, 'commit', '--quiet', '-m', 'fixture baseline');
  const baseline = git(repo, 'rev-parse', 'HEAD');
  write(repo, 'src/example.js', 'export const revision = 2;\n');
  write(repo, 'src/new-memory.js', 'export const feature = "memory";\n');
  write(repo, 'scripts/verify-memory-package.mjs', fs.readFileSync(path.join(scriptsDir, 'verify-memory-package.mjs')));
  git(repo, 'add', 'src/example.js', 'src/new-memory.js', 'scripts/verify-memory-package.mjs');
  git(repo, 'commit', '--quiet', '-m', 'fixture upgrade');
  const archive = path.join(root, 'source-archive.zip');
  fs.writeFileSync(archive, 'synthetic fixture archive identity');
  return { root, repo, target, baseline, original, archive, output: path.join(root, 'delivery package') };
}

async function build(t) {
  const m = await modules();
  const f = fixture(t);
  const result = m.packageUpgrade({ repositoryRoot: f.repo, baselineRef: f.baseline,
    outputDir: f.output, sourceArchive: f.archive });
  return { ...f, ...m, result };
}

test('不同路径检查和安装只更新清单代码，保留配置、记忆、日记和人格', async (t) => {
  const f = await build(t);
  const manifest = JSON.parse(fs.readFileSync(path.join(f.output, 'manifest.json')));
  assert.ok(manifest.files.some((entry) => entry.path === 'src/example.js' && entry.beforeSha256 && entry.afterSha256));
  assert.ok(manifest.files.some((entry) => entry.path === 'src/new-memory.js' && entry.beforeSha256 === null));
  assert.ok(manifest.files.every((entry) => !/^(config\.json|state\/|data\/|roles\/|node_modules\/)/.test(entry.path)));
  const check = f.verifyUpgrade({ packageDir: f.output, targetDir: f.target });
  assert.equal(check.applied, false);
  assert.equal(fs.readFileSync(path.join(f.target, 'src/example.js'), 'utf8'), f.original['src/example.js']);
  const installed = f.verifyUpgrade({ packageDir: f.output, targetDir: f.target, apply: true });
  assert.equal(installed.applied, true);
  assert.equal(fs.readFileSync(path.join(f.target, 'src/example.js'), 'utf8'), 'export const revision = 2;\n');
  for (const name of ['config.json', 'state/social-v2.json', 'data/日记/diary.jsonl', 'roles/persona.md']) {
    assert.equal(fs.readFileSync(path.join(f.target, name), 'utf8'), f.original[name]);
  }
  assert.ok(f.verifyUpgrade({ packageDir: f.output, targetDir: f.target }).files.every((entry) => entry.status === 'already-patched'));
});

test('后一个文件发生目标冲突时，前一个代码文件也不能被覆盖', async (t) => {
  const f = await build(t);
  write(f.target, 'src/new-memory.js', 'user custom code\n');
  assert.throws(() => f.verifyUpgrade({ packageDir: f.output, targetDir: f.target, apply: true }), /src\/new-memory\.js.*冲突/);
  assert.equal(fs.readFileSync(path.join(f.target, 'src/example.js'), 'utf8'), f.original['src/example.js']);
  assert.equal(fs.readFileSync(path.join(f.target, 'src/new-memory.js'), 'utf8'), 'user custom code\n');
});

test('包内代码哈希不符和额外私有文件都拒绝，拒绝前不写目标', async (t) => {
  const f = await build(t);
  const file = path.join(f.output, 'payload/src/example.js');
  const original = fs.readFileSync(file);
  fs.writeFileSync(file, 'altered payload\n');
  assert.throws(() => f.verifyUpgrade({ packageDir: f.output, targetDir: f.target, apply: true }), /哈希/);
  fs.writeFileSync(file, original);
  write(f.output, 'payload/config.json', '{"syntheticSecret":true}');
  assert.throws(() => f.verifyUpgrade({ packageDir: f.output, targetDir: f.target, apply: true }), /清单外|禁止/);
  assert.equal(fs.readFileSync(path.join(f.target, 'src/example.js'), 'utf8'), f.original['src/example.js']);
});

test('提交差异包含真实配置目录时打包拒绝，不能静默混入交付', async (t) => {
  const m = await modules();
  const f = fixture(t);
  write(f.repo, 'config.json', '{"token":"changed-synthetic-token"}');
  git(f.repo, 'add', 'config.json');
  git(f.repo, 'commit', '--quiet', '-m', 'fixture protected change');
  assert.throws(() => m.packageUpgrade({ repositoryRoot: f.repo, baselineRef: f.baseline,
    outputDir: f.output, sourceArchive: f.archive }), /config\.json.*禁止/);
  assert.equal(fs.existsSync(f.output), false);
});

test('清单中的目录穿越路径被拒绝', async (t) => {
  const f = await build(t);
  const manifestPath = path.join(f.output, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath));
  manifest.files[0].path = '../config.json';
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(() => f.verifyUpgrade({ packageDir: f.output, targetDir: f.target, apply: true }), /路径|禁止/);
  assert.equal(fs.readFileSync(path.join(f.target, 'src/example.js'), 'utf8'), f.original['src/example.js']);
});

test('清单来源信息缺失时在复制前拒绝', async (t) => {
  const f = await build(t);
  const manifestPath = path.join(f.output, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath));
  delete manifest.source;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(() => f.verifyUpgrade({ packageDir: f.output, targetDir: f.target, apply: true }), /来源/);
  assert.equal(fs.readFileSync(path.join(f.target, 'src/example.js'), 'utf8'), f.original['src/example.js']);
});

test('大小写别名与目录链接不能把交付写进源码目录', async (t) => {
  const m = await modules();
  const f = fixture(t);
  const buildAt = (outputDir) => m.packageUpgrade({ repositoryRoot: f.repo, baselineRef: f.baseline,
    outputDir, sourceArchive: f.archive });
  if (process.platform === 'win32') {
    const alternateCase = f.repo.replace('source repo', 'SOURCE REPO');
    assert.throws(() => buildAt(path.join(alternateCase, 'nested', 'delivery')), /源码目录之外/);
    assert.equal(fs.existsSync(path.join(f.repo, 'nested')), false);
  }
  const linked = path.join(f.root, 'repository-alias');
  fs.symlinkSync(f.repo, linked, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => buildAt(path.join(linked, 'nested', 'delivery')), /源码目录之外/);
  assert.equal(fs.existsSync(path.join(f.repo, 'nested')), false);
});

test('交付根目录的校验CLI可在无Git的目标目录运行，不依赖固定用户名', async (t) => {
  const f = await build(t);
  const result = spawnSync(process.execPath, [path.join(f.output, 'verify-memory-package.mjs'),
    '--target', f.target, '--apply'], { cwd: f.root, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).applied, true);
  assert.equal(fs.readFileSync(path.join(f.target, 'src/example.js'), 'utf8'), 'export const revision = 2;\n');
});
