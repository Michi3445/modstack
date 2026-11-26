const fs = require('node:fs');
const disk = require('original-fs');
const path = require('node:path');
const { createHash, verify } = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { databaseURL } = require('./friends-project.json');

const REPO = 'https://github.com/Michi3445/modstack/releases';
const GITHUB_HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
const VERSION = /^(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5})$/;
const PUBLIC_KEY = fs.readFileSync(path.join(__dirname, 'update-public.pem'));
const FILES = { asar: 'Modstack-app.asar', full: 'Modstack-win.zip' };
const MAX_BYTES = { asar: 128 * 1024 * 1024, full: 600 * 1024 * 1024 };

function newer(version, current) {
  if (!VERSION.test(current)) return false;
  const parts = current.split('.').map(Number);
  const candidate = version.split('.').map(Number);
  const ix = candidate.findIndex((value, index) => value !== parts[index]);
  return ix !== -1 && candidate[ix] > parts[ix];
}

function parseManifest(raw) {
  const doc = JSON.parse(raw);
  if (typeof doc?.payload !== 'string' || typeof doc?.signature !== 'string') throw new Error('Ungültige Update-Datei.');
  const payload = Buffer.from(doc.payload, 'base64url');
  if (!verify(null, payload, PUBLIC_KEY, Buffer.from(doc.signature, 'base64url'))) {
    throw new Error('Die Signatur des Updates ist ungültig.');
  }
  const release = JSON.parse(payload.toString('utf8'));
  if (!release || release.format !== 1 || typeof release.version !== 'string' || !VERSION.test(release.version) ||
      typeof release.electron !== 'string' || !VERSION.test(release.electron) ||
      release.platform !== 'win32-x64' || !release.assets?.full) throw new Error('Ungültige Update-Version.');
  for (const [kind, asset] of Object.entries(release.assets)) {
    if (!Object.hasOwn(FILES, kind) || asset?.name !== FILES[kind] || !Number.isSafeInteger(asset.size) ||
        asset.size < 1 || asset.size > MAX_BYTES[kind] || !/^[a-f0-9]{64}$/.test(asset.sha256)) {
      throw new Error('Ungültige Update-Datei.');
    }
  }
  return release;
}

async function github(file, version, timeout, cancel) {
  let url = new URL(version ? REPO + '/download/v' + version + '/' + file : REPO + '/latest/download/' + file);
  const deadline = AbortSignal.timeout(timeout);
  const signal = cancel ? AbortSignal.any([deadline, cancel]) : deadline;
  for (let i = 0; i < 6; i++) {
    if (url.protocol !== 'https:' || !GITHUB_HOSTS.has(url.hostname) || url.port || url.username || url.password) break;
    const response = await fetch(url, { redirect: 'manual', signal });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) break;
    url = new URL(location, url);
  }
  throw new Error('Die Update-Adresse konnte nicht bestätigt werden.');
}

async function manifest(version) {
  const response = await github('modstack-update.json', version, 10000);
  if (response.status === 404) { await response.body?.cancel(); return null; }
  if (!response.ok) { await response.body?.cancel(); throw new Error('Der Update-Server ist gerade nicht erreichbar.'); }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 32768) throw new Error('Die Update-Datei ist ungültig.');
    chunks.push(chunk);
  }
  const release = parseManifest(Buffer.concat(chunks).toString('utf8'));
  if (version && version !== release.version) throw new Error('Die angekündigte Update-Version stimmt nicht überein.');
  return release;
}

async function announcedVersion() {
  try {
    const response = await fetch(databaseURL + '/modstackUpdates/windows-x64.json', {
      redirect: 'error', signal: AbortSignal.timeout(3500),
    });
    if (!response.ok) { await response.body?.cancel(); return null; }
    // Firebase enthält nur die veröffentlichte Versionsnummer.
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 128) return null;
      chunks.push(chunk);
    }
    const version = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return typeof version === 'string' && VERSION.test(version) ? version : null;
  } catch { return null; }
}

async function download(asset, version, destination, onProgress, cancel) {
  const response = await github(asset.name, version, 240000, cancel);
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error('Das Update konnte nicht heruntergeladen werden.');
  }
  const digest = createHash('sha256');
  let size = 0, percent = 0;
  await pipeline(Readable.fromWeb(response.body), new Transform({
    transform(chunk, _encoding, cb) {
      size += chunk.length;
      if (size > asset.size) { cb(new Error('Der Update-Download ist größer als angekündigt.')); return; }
      digest.update(chunk);
      const next = Math.floor(size * 100 / asset.size);
      if (next >= percent + 5) { percent = next; onProgress(size, asset.size); }
      cb(null, chunk);
    },
  }), disk.createWriteStream(destination, { flags: 'wx' }));
  if (size !== asset.size || digest.digest('hex') !== asset.sha256) throw new Error('Der Update-Download ist beschädigt.');
}

module.exports = function registerUpdater(ipc, app, status, settings) {
  const supported = app.isPackaged && process.platform === 'win32' && process.arch === 'x64';
  const current = app.getVersion();
  const updateLog = path.join(app.getPath('userData'), 'app-update-error.log');
  const verifyOnly = process.env.MODSTACK_UPDATE_VERIFY_ONLY === '1';
  let pending, checking, preparing, prepared, cancel, armed = false, quitPending = false;
  const kindFor = (release) => release.electron === process.versions.electron && release.assets.asar ? 'asar' : 'full';
  function updateInfo() {
    const release = prepared?.release || pending;
    if (!release) return { current, supported };
    return { current, supported, version: release.version, bytes: release.assets[kindFor(release)].size, prepared: Boolean(prepared) };
  }

  ipc.handle('appUpdate:check', () => {
    if (!supported || prepared || verifyOnly) return updateInfo();
    if (!checking) {
      checking = (async () => {
        const announced = await announcedVersion();
        const latest = await manifest(null);
        const release = announced && newer(announced, latest?.version || current) ? await manifest(announced) || latest : latest;
        pending = release && newer(release.version, current) ? release : null;
        return updateInfo();
      })().finally(() => { checking = null; });
    }
    return checking;
  });

  function discardStage(stage) {
    try { disk.rmSync(stage, { recursive: true, force: true, maxRetries: 2 }); } catch {}
  }

  async function prepare(release, automatic, signal) {
    const kind = kindFor(release);
    const asset = release.assets[kind];
    const appDir = path.dirname(process.execPath);
    let stage;
    try {
      if (path.win32.basename(process.execPath).toLowerCase() !== 'modstack.exe' ||
          !fs.existsSync(path.join(appDir, 'resources', 'app.asar'))) throw new Error('Dieser Modstack-Ordner ist nicht updatefähig.');
      const localData = path.relative(appDir, app.getPath('userData'));
      if (kind === 'full' && (!localData || (!path.isAbsolute(localData) && !localData.startsWith('..' + path.sep) && localData !== '..'))) {
        throw new Error('Verschiebe den Programmordner für dieses Update aus dem Modstack-Datenordner.');
      }
      stage = fs.mkdtempSync(path.join(path.dirname(appDir), '.modstack-update-'));
      const target = path.join(stage, kind === 'asar' ? 'app.asar' : asset.name);
      await download(asset, release.version, target, (size, total) => {
        if (!automatic) status(`App-Update: ${size}/${total} Bytes`);
      }, signal);
      if (kind === 'asar' && JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8')).version !== release.version) {
        throw new Error('Die Version im Update-Paket stimmt nicht überein.');
      }
      fs.writeFileSync(path.join(stage, 'install.ps1'), fs.readFileSync(path.join(__dirname, 'update-windows.ps1')));
      return { release, kind, asset, appDir, stage };
    } catch (error) {
      if (stage) discardStage(stage);
      if (['EACCES', 'EPERM'].includes(error.code)) throw new Error('Modstack braucht Schreibzugriff auf seinen Programmordner.');
      if (error.name === 'TimeoutError' || error instanceof TypeError) throw new Error('Der Update-Download ist gerade nicht erreichbar.');
      throw error;
    }
  }

  function preparePending(automatic) {
    if (prepared) return Promise.resolve(prepared);
    if (preparing) return preparing;
    if (!supported || verifyOnly || !pending) throw new Error('Es ist gerade kein App-Update verfügbar.');
    cancel = new AbortController();
    preparing = prepare(pending, automatic, cancel.signal).then((result) => (prepared = result))
      .finally(() => { preparing = null; cancel = null; });
    return preparing;
  }

  function armUpdate(restart) {
    const { release, kind, asset, appDir, stage } = prepared;
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const command = "& ([scriptblock]::Create([IO.File]::ReadAllText((Join-Path $env:MODSTACK_UPDATER_STAGE 'install.ps1'))))";
    Object.assign(process.env, {
      MODSTACK_UPDATER_STAGE: stage, MODSTACK_UPDATER_ROOT: appDir,
      MODSTACK_UPDATER_MODE: kind, MODSTACK_UPDATER_HASH: asset.sha256, MODSTACK_UPDATER_LOG: updateLog,
      MODSTACK_UPDATER_ELECTRON: release.electron, MODSTACK_UPDATER_VERSION: release.version,
      MODSTACK_UPDATER_RESTART: restart ? '1' : '0',
    });
    process.chdir(path.dirname(appDir));
    app.relaunch({ execPath: powershell, args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', command] });
    armed = true;
  }

  ipc.handle('appUpdate:prepare', async () => {
    if (settings().autoAppUpdate === false) return updateInfo();
    await preparePending(true);
    return updateInfo();
  });

  ipc.handle('appUpdate:install', async () => {
    if (armed || quitPending) return false;
    await preparePending(false);
    if (armed || quitPending) return false;
    armUpdate(true);
    setTimeout(() => app.quit(), 150);
    return true;
  });

  app.on('before-quit', (event) => {
    if (armed || verifyOnly) return;
    if (preparing) {
      event.preventDefault();
      if (quitPending) return;
      quitPending = true;
      cancel.abort();
      preparing.catch(() => {}).finally(() => app.quit());
      return;
    }
    if (!prepared) return;
    if (settings().autoAppUpdate === false) { discardStage(prepared.stage); return; }
    try { armUpdate(false); }
    catch (error) {
      fs.writeFileSync(updateLog, error.message);
      discardStage(prepared.stage);
    }
  });

  ipc.handle('appUpdate:ready', () => {
    const receipt = process.env.MODSTACK_UPDATE_RECEIPT;
    if (receipt) {
      fs.writeFileSync(receipt, current);
      delete process.env.MODSTACK_UPDATE_RECEIPT;
    }
    if (verifyOnly) { setTimeout(() => app.exit(0), 1200); return ''; }
    try {
      const error = fs.readFileSync(updateLog, 'utf8').trim();
      fs.rmSync(updateLog, { force: true });
      return error;
    } catch { return ''; }
  });
};
