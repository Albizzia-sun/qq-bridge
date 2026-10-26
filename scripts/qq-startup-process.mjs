// Read-only account-to-PID discovery. Never opens message contents or loads a hook.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

export function startupProcessPaths(config) {
  const uin = String(config?.startup?.accountUin ?? '');
  const dataDirectory = config?.startup?.qqDataDirectory;
  const snowlumaHome = config?.snowluma?.homeDir;
  if (!/^[1-9][0-9]{4,9}$/.test(uin)) throw new Error('Invalid startup.accountUin.');
  if (typeof dataDirectory !== 'string' || !path.win32.isAbsolute(dataDirectory)) {
    throw new Error('startup.qqDataDirectory must be an absolute Windows path.');
  }
  if (typeof snowlumaHome !== 'string' || !path.win32.isAbsolute(snowlumaHome)) {
    throw new Error('snowluma.homeDir must be an absolute Windows path.');
  }
  return {
    database: path.win32.join(dataDirectory, uin, 'nt_qq', 'nt_db', 'nt_msg.db'),
    native: path.win32.join(snowlumaHome, 'native', 'snowluma-win32-x64.node'),
  };
}

export function qqHolderPids(holders) {
  if (!Array.isArray(holders)) throw new Error('Invalid native file-holder result.');
  return [...new Set(holders.filter((holder) =>
    Number.isInteger(holder?.pid) && holder.pid > 0 && holder.pid <= 4194304
    && typeof holder.name === 'string' && /^qq(?:\.exe)?$/i.test(holder.name.trim())
  ).map((holder) => holder.pid))].sort((a, b) => a - b);
}

export async function findStartupQqPids(config, loadNative = require) {
  const paths = startupProcessPaths(config);
  const addon = loadNative(paths.native);
  if (typeof addon?.getFileHoldersAsync !== 'function') {
    throw new Error('SnowLuma native addon does not expose getFileHoldersAsync.');
  }
  return qqHolderPids(await addon.getFileHoldersAsync(paths.database));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const text = await fs.readFile(new URL('../config.json', import.meta.url), 'utf8');
    const config = JSON.parse(text.replace(/^\uFEFF/, ''));
    process.stdout.write(`${JSON.stringify(await findStartupQqPids(config))}\n`);
  } catch (error) {
    process.stderr.write(`QQ startup process discovery failed: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  }
}
