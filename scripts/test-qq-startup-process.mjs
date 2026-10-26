import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startupProcessPaths, qqHolderPids, findStartupQqPids } from './qq-startup-process.mjs';

const config = {
  startup: { accountUin: '3333333333', qqDataDirectory: 'C:\\QQ Data\\Tencent Files' },
  snowluma: { homeDir: 'C:\\Tools\\SnowLuma' },
};

test('resolve only the configured account database and installed native addon', () => {
  assert.deepEqual(startupProcessPaths(config), {
    database: 'C:\\QQ Data\\Tencent Files\\3333333333\\nt_qq\\nt_db\\nt_msg.db',
    native: 'C:\\Tools\\SnowLuma\\native\\snowluma-win32-x64.node',
  });
  for (const accountUin of ['', '../3333333333', '3333333333\\other', 'not-an-account']) {
    assert.throws(() => startupProcessPaths({ ...config, startup: { ...config.startup, accountUin } }), /accountUin/);
  }
  assert.throws(() => startupProcessPaths({ ...config, startup: { ...config.startup, qqDataDirectory: 'relative' } }), /qqDataDirectory/);
  assert.throws(() => startupProcessPaths({ ...config, snowluma: { homeDir: '' } }), /homeDir/);
});

test('return unique valid QQ holder PIDs, excluding unrelated processes and invalid values', () => {
  assert.deepEqual(qqHolderPids([
    { pid: 123, name: 'QQ.exe' }, { pid: 123, name: 'qq' }, { pid: 456, name: ' QQ.EXE ' },
    { pid: 789, name: 'not-QQ.exe' }, { pid: 0, name: 'QQ.exe' },
    { pid: -1, name: 'QQ.exe' }, { pid: 1.5, name: 'QQ.exe' },
    { pid: '123', name: 'QQ.exe' }, { pid: 4194305, name: 'QQ.exe' }, null,
  ]), [123, 456]);
  assert.deepEqual(qqHolderPids([]), []);
  assert.throws(() => qqHolderPids({ pid: 123, name: 'QQ.exe' }), /holder result/);
});

test('use only the native read-only file-holder query without loading a hook', async () => {
  let queries = 0;
  const pids = await findStartupQqPids(config, (nativePath) => {
    assert.equal(nativePath, startupProcessPaths(config).native);
    return {
      getFileHoldersAsync: async (database) => {
        queries++;
        assert.equal(database, startupProcessPaths(config).database);
        return [{ pid: 123, name: 'QQ.exe' }];
      },
      loadModuleManualAsync: () => { throw new Error('Hook loading must never be called.'); },
    };
  });
  assert.deepEqual(pids, [123]);
  assert.equal(queries, 1);
  await assert.rejects(findStartupQqPids(config, () => ({})), /getFileHoldersAsync/);
});
