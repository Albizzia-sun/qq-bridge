import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { NodeApiClient, isLoopbackBase, unwrap } from './dsh-client.js';

const runFile = promisify(execFile);
// Desktop 0.2.1 starts its host with --port 0 and only publishes the URL over
// parent/child IPC. Query the configured executable's host, not all Electron
// processes or arbitrary local ports. The path is data, never PowerShell code.
const DISCOVER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$hostIds = @(Get-CimInstance Win32_Process -Filter "Name = 'DeepSeek Harness.exe'" | Where-Object {
  $_.ExecutablePath -eq $env:QQ_BRIDGE_DSH_DESKTOP_EXE -and
  $_.CommandLine -match '[\\/]dsh-desktop-host[\\/]lib[\\/]index\.js(?:["\s]|$)'
} | Select-Object -ExpandProperty ProcessId)
if ($hostIds.Count -eq 0) { '[]'; exit }
$listeners = @(Get-NetTCPConnection -State Listen | Where-Object {
  $_.OwningProcess -in $hostIds -and $_.LocalAddress -eq '127.0.0.1'
} | Select-Object LocalAddress, LocalPort)
ConvertTo-Json -InputObject $listeners -Compress
`;

export async function discoverDesktopBaseUrls(executablePath, { platform = process.platform, run = runFile } = {}) {
  if (platform !== 'win32' || !executablePath) return [];
  const powershell = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const { stdout } = await run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', DISCOVER_SCRIPT], {
    windowsHide: true,
    timeout: 8000,
    maxBuffer: 64 * 1024,
    env: { ...process.env, QQ_BRIDGE_DSH_DESKTOP_EXE: executablePath }
  });
  const listeners = JSON.parse(stdout.trim());
  if (!Array.isArray(listeners)) throw new Error('invalid DSH desktop listener result');
  return [...new Set(listeners
    .filter(entry => entry?.LocalAddress === '127.0.0.1' && Number.isInteger(entry.LocalPort)
      && entry.LocalPort > 0 && entry.LocalPort <= 65535)
    .map(entry => `http://127.0.0.1:${entry.LocalPort}`))];
}

/** Use the existing health check to recover a desktop connection; do not replay RPC mutations. */
export async function checkDshConnection(api, { desktopExecutable, discover = discoverDesktopBaseUrls } = {}) {
  const followDesktop = Boolean(desktopExecutable) && isLoopbackBase(api.baseUrl);
  try {
    unwrap(await api.settings.describe({}, followDesktop ? AbortSignal.timeout(4000) : undefined), 'settings.describe');
    return { ready: true };
  } catch {
    if (!followDesktop) return { ready: false };
  }
  const candidates = await discover(desktopExecutable);
  // Never guess between different hosts/listeners or replace a configured remote.
  if (candidates.length !== 1 || candidates[0] === api.baseUrl) return { ready: false };
  const nextBaseUrl = candidates[0];
  const probe = new NodeApiClient(nextBaseUrl, 4000, api.auth);
  try {
    unwrap(await probe.settings.describe({}, AbortSignal.timeout(4000)), 'settings.describe');
  } catch {
    return { ready: false };
  }
  const previousBaseUrl = api.baseUrl;
  api.setBaseUrl(nextBaseUrl);
  return { ready: true, previousBaseUrl, baseUrl: nextBaseUrl };
}
