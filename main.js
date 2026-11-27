const { app, BrowserWindow, ipcMain: rawIpc, shell, dialog, nativeImage, Notification, clipboard, Tray, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const zlib = require('zlib');
const { execFile, spawn } = require('child_process');
const { bindings, writeBinding, presetBindings, savePresetBinding, applyOptionDefaults } = require('./minecraft-keybinds');
const { updateOptionDefaults } = require('./minecraft-options');

// ipcMain.handle ruft (event, daten) auf; die Handler unten erwarten nur die Daten.
const ipcMain = { handle: (ch, fn) => rawIpc.handle(ch, (_e, data) => fn(data)) };

const UA = 'Modstack/1.1 (persoenliches Projekt)';
const MR = 'https://api.modrinth.com/v2';
const LOADERS = ['fabric', 'forge', 'neoforge', 'quilt'];

let win;
let tray, quitting = false, askingToClose = false, hiddenForGame = false;
// Datenordner vom alten Namen behalten, damit vorhandene Instanzen bleiben
app.setPath('userData', path.join(app.getPath('appData'), 'modmanager'));
const hasAppLock = !app.isPackaged || app.requestSingleInstanceLock();
require('./updater')(ipcMain, app, status, appSettings);
const instRoot = () => path.join(app.getPath('userData'), 'instances');
const mcDir = () => path.join(process.env.APPDATA || '', '.minecraft');

function status(msg) {
  if (win && !win.isDestroyed()) win.webContents.send('status', msg);
}

let friendNotification;
function notifyFriendChat({ arrived, unread, contactsChanged, requested = 0, requests, groupsChanged, newGroupInvites = 0, groupInvites }) {
  if (!win || win.isDestroyed()) return;
  const settings = appSettings();
  const message = newGroupInvites ? newGroupInvites === 1 ? 'Du hast eine neue Gruppeneinladung.' : `Du hast ${newGroupInvites} neue Gruppeneinladungen.`
    : requested > 0 ? requested === 1 ? 'Du hast eine neue Freundschaftsanfrage.' : `Du hast ${requested} neue Freundschaftsanfragen.`
    : arrived.length > 1 ? `Neue Nachrichten in ${arrived.length} Chats`
      : arrived[0]?.kind === 'screenshot' ? 'Ein Screenshot wurde im Chat geteilt.'
        : arrived[0]?.kind === 'pack' ? 'Ein Freund hat ein Modpack geteilt.' : arrived.length ? 'Du hast eine neue Chatnachricht.' : '';
  const popup = settings.friendsPopup !== false;
  win.webContents.send('friendChat', {
    arrived, unread, contactsChanged, requests, requested, groupsChanged, newGroupInvites, groupInvites, sound: !!message && settings.friendsSound !== false,
    toast: popup && win.isFocused() ? message : '',
  });
  if (!message || !popup || win.isFocused() || !Notification.isSupported()) return;
  friendNotification?.close();
  friendNotification = new Notification({ title: 'Modstack · Freunde', body: message, silent: true });
  friendNotification.on('click', () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.webContents.send('friendChat', { open: true, showRequests: requested > 0, showGroups: newGroupInvites > 0 });
  });
  friendNotification.show();
}

// ---------- Hilfsfunktionen ----------
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
async function getJson(url, signal) {
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal });
  if (!r.ok) throw new Error(`HTTP ${r.status} bei ${url}`);
  return r.json();
}

async function download(url, dest, sha1) {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`Download fehlgeschlagen (${r.status}): ${url}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (sha1) {
    const h = crypto.createHash('sha1').update(buf).digest('hex');
    if (h !== sha1) throw new Error('Pruefsumme stimmt nicht: ' + path.basename(dest));
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
}

function safeName(s) {
  return String(s).replace(/[^a-zA-Z0-9_\-. ]/g, '_').trim().slice(0, 60) || 'instanz';
}

function instDir(id) {
  return path.join(instRoot(), safeName(id));
}

function readInst(id) {
  return readJson(path.join(instDir(id), 'instance.json'));
}

function saveInst(inst) {
  const dir = instDir(inst.id);
  const temp = path.join(dir, '.instance-' + crypto.randomUUID() + '.json');
  try {
    fs.writeFileSync(temp, JSON.stringify(inst, null, 2), { flag: 'wx' });
    fs.renameSync(temp, path.join(dir, 'instance.json'));
  } finally { fs.rmSync(temp, { force: true }); }
}

function instanceRam(value) {
  const ram = Number(value);
  return Number.isFinite(ram) && ram > 0 ? Math.max(1024, Math.min(65536, Math.trunc(ram))) : undefined;
}

function instanceJavaArgs(value) {
  return String(value || '').replace(/-Xm[xs]\S*/g, '').trim() || undefined;
}

function saveNewInst(inst) {
  const defaults = appSettings();
  inst.ram = instanceRam(defaults.defaultRam);
  inst.javaArgs = instanceJavaArgs(defaults.defaultJavaArgs);
  applyOptionDefaults(path.join(instDir(inst.id), 'options.txt'), inst.mc, defaults);
  saveInst(inst);
  gamePreparation.schedule(inst);
}

// ---------- Instanzen ----------
ipcMain.handle('instances:list', async () => {
  fs.mkdirSync(instRoot(), { recursive: true });
  const out = [];
  for (const d of fs.readdirSync(instRoot())) {
    const f = path.join(instRoot(), d, 'instance.json');
    if (fs.existsSync(f)) {
      try { out.push(await instanceWork(d, () => reconcileMods(readJson(f)))); } catch {}
    }
  }
  return out;
});

ipcMain.handle('instances:create', ({ name, mc, loader }) => {
  if (!LOADERS.includes(loader)) throw new Error('Unbekannter Loader');
  let id = safeName(name);
  let n = 1;
  while (fs.existsSync(instDir(id))) id = safeName(name) + '_' + ++n;
  fs.mkdirSync(path.join(instDir(id), 'mods'), { recursive: true });
  const inst = { id, name, mc, loader, mods: [], created: new Date().toISOString() };
  saveNewInst(inst);
  return inst;
});

ipcMain.handle('instances:delete', (id) => {
  fs.rmSync(instDir(id), { recursive: true, force: true });
  return true;
});

ipcMain.handle('instances:openFolder', (id) => {
  shell.openPath(instDir(id));
  return true;
});

ipcMain.handle('mc:versions', async () => {
  const m = await getJson('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
  return m.versions.filter((v) => v.type === 'release').map((v) => v.id);
});

// ---------- Modrinth ----------
const KIND_DIR = { mod: 'mods', resourcepack: 'resourcepacks', shader: 'shaderpacks' };
const kindOf = (m) => m.kind || 'mod';
function modFile(name) {
  if (typeof name !== 'string' || name.length > 240 || !/^[^<>:"/\\|?*\x00-\x1f]+\.(?:jar|zip)$/i.test(name) ||
      /^(?:CON|NUL|PRN|AUX|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name)) throw new Error('Ungültiger Dateiname.');
  return name;
}
const entryPath = (id, m) => path.join(instDir(id), KIND_DIR[kindOf(m)], modFile(m.file) + (m.disabled ? '.disabled' : ''));

function reconcileMods(inst) {
  const base = instDir(inst.id);
  if (fs.lstatSync(base, { throwIfNoEntry: false })?.isSymbolicLink()) return inst;
  const key = (kind, file) => kind + ':' + file.toLowerCase();
  const present = new Map();
  for (const [kind, dir] of Object.entries(KIND_DIR)) {
    const folder = path.join(base, dir);
    if (!fs.lstatSync(folder, { throwIfNoEntry: false })?.isDirectory()) continue;
    for (const item of fs.readdirSync(folder, { withFileTypes: true })) {
      if (!item.isFile()) continue;
      const disabled = /\.disabled$/i.test(item.name);
      let file;
      try { file = modFile(disabled ? item.name.slice(0, -9) : item.name); } catch { continue; }
      const id = key(kind, file);
      if (!present.has(id) || !disabled) present.set(id, { kind, file, disabled });
    }
  }
  const mods = [];
  let changed = false;
  for (const old of inst.mods || []) {
    const id = key(kindOf(old), old.file);
    const current = present.get(id);
    if (!current) { changed = true; continue; }
    present.delete(id);
    if (current.disabled === !!old.disabled && current.file === old.file) mods.push(old);
    else { mods.push({ ...old, ...current }); changed = true; }
  }
  for (const item of present.values()) {
    mods.push({ ...item, title: item.file.replace(/\.(jar|zip)$/i, ''), manual: true });
    changed = true;
  }
  if (changed) { inst.mods = mods; saveInst(inst); }
  return inst;
}

ipcMain.handle('mr:search', async ({ query, mc, loader, offset, type }) => {
  type = type || 'mod';
  const facets = [[`project_type:${type}`]];
  if (type !== 'modpack') facets.push([`versions:${mc}`]);
  if (type === 'mod') facets.push(loader === 'quilt' ? ['categories:quilt', 'categories:fabric'] : [`categories:${loader}`]);
  if (type === 'modpack' && loader) facets.push([`categories:${loader}`]);
  if (type === 'modpack' && mc) facets.push([`versions:${mc}`]);
  const url = `${MR}/search?query=${encodeURIComponent(query || '')}&facets=${encodeURIComponent(JSON.stringify(facets))}&limit=20&offset=${offset || 0}&index=${query ? 'relevance' : 'downloads'}`;
  const r = await getJson(url);
  return r.hits.map((h) => ({
    id: h.project_id,
    slug: h.slug,
    title: h.title,
    author: h.author,
    description: h.description,
    downloads: h.downloads,
    icon: h.icon_url,
    versions: h.versions,
    categories: h.display_categories || h.categories,
  }));
});

function loaderList(inst) {
  return inst.loader === 'quilt' ? ['quilt', 'fabric'] : [inst.loader];
}

function appSettings() { try { return readJson(settingsFile()); } catch { return {}; } }
function friendPresenceOptions() {
  const settings = appSettings();
  return { online: settings.friendsOnline === true, pack: settings.friendsPlaying === true };
}

function runningModstackInstances() {
  if (process.platform !== 'win32') return Promise.resolve([]);
  // Inspect Java's arguments locally. Send only the instance folder name back to Node.
  const script = [
    '$root = [IO.Path]::GetFullPath($env:MODSTACK_INSTANCES)',
    '$ErrorActionPreference = "Stop"',
    `Get-CimInstance Win32_Process -Filter "Name = 'javaw.exe' OR Name = 'java.exe'" | ForEach-Object {`,
    `  $match = [regex]::Match([string]$_.CommandLine, '--gameDir(?:=|\\s+)(?:"([^"]+)"|(\\S+))')`,
    '  if ($match.Success) { try {',
    '    $dir = [IO.Path]::GetFullPath(($match.Groups[1].Value + $match.Groups[2].Value))',
    '    if ([IO.Path]::GetDirectoryName($dir) -ieq $root) { [IO.Path]::GetFileName($dir) }',
    '  } catch {} }',
    '}',
  ].join('\n');
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => execFile(exe, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    windowsHide: true, timeout: 4500, env: { ...process.env, MODSTACK_INSTANCES: instRoot() },
  }, (error, output) => {
    if (error) { reject(new Error('Laufende Minecraft-Instanzen konnten nicht geprüft werden.')); return; }
    resolve(output.trim().split(/\r?\n/).filter((id) => id && safeName(id) === id && id !== '.' && id !== '..'));
  }));
}

async function runningModstackPack() {
  try {
    for (const id of await runningModstackInstances()) {
      try { return String(readInst(id).name || '') || null; } catch {}
    }
  } catch {}
  return null;
}

const backups = require('./instance-backups')({
  root: path.join(app.getPath('userData'), 'backups'), instDir, readInst,
  running: runningModstackInstances, settings: appSettings, status,
});
const history = require('./mod-history')({ instDir, entryPath, saveInst, settings: appSettings });
const diagnostics = require('./crash-diagnostics')({
  instDir, readInst, entryPath, readZip, settings: appSettings,
  idle: async (id) => !(await runningModstackInstances()).some((active) => active.toLowerCase() === id.toLowerCase()),
});
const instanceJobs = new Map();
function instanceWork(id, fn) {
  const key = safeName(id).toLowerCase();
  const task = (instanceJobs.get(key) || Promise.resolve()).catch(() => {}).then(fn);
  instanceJobs.set(key, task);
  return task.finally(() => { if (instanceJobs.get(key) === task) instanceJobs.delete(key); });
}
ipcMain.handle('instances:rescanMods', (id) => instanceWork(id, () => reconcileMods(readInst(id))));
const syncLocal = require('./sync-local')({
  readInst, saveInst, instDir, instRoot, newInstId, saveNewInst, instanceWork, kindOf, entryPath,
  resolveLoaderVersion, fetchVersion: (id) => getJson(`${MR}/version/${encodeURIComponent(id)}`),
  download: downloadModrinth, history, backups,
});
require('./friends')(ipcMain, app.getPath('userData'), readMinecraftAccount, buildShareCode, notifyFriendChat,
  friendPresenceOptions, runningModstackPack, { local: syncLocal, enabled: () => appSettings().packSync !== false, screenshots: () => appSettings().screenshotsEnabled !== false });
require('./instance-screenshots')({
  ipc: ipcMain, instDir, readInst, cache: path.join(app.getPath('userData'), 'screenshot-cache'),
  settings: appSettings, nativeImage, clipboard, shell,
});

function packChanged(id) {
  if (appSettings().packSync !== false && readInst(id).sync?.role === 'owner' && win && !win.isDestroyed()) {
    win.webContents.send('packSyncChanged', id);
  }
}

ipcMain.handle('backups:list', (id) => backups.list(id));
ipcMain.handle('backups:create', (id) => instanceWork(id, () => backups.snapshot(id, 'Manuell', { required: true })));
ipcMain.handle('backups:restore', ({ id, key }) => instanceWork(id, () => backups.restore(id, key)));
ipcMain.handle('history:previous', ({ id, file }) => history.previous(readInst(id), file));
ipcMain.handle('history:list', (id) => history.list(readInst(id)));
ipcMain.handle('history:undo', ({ id, key, through }) => instanceWork(id, async () => {
  await backups.ensureIdle(id);
  history.undo(readInst(id), key, through === true);
  packChanged(id);
  return readInst(id);
}));
ipcMain.handle('history:disk', () => {
  if (!fs.existsSync(instRoot())) return 0;
  return fs.readdirSync(instRoot()).reduce((total, id) => {
    try { return total + history.bytes(readInst(id)); } catch { return total; }
  }, 0);
});
ipcMain.handle('history:clearAll', async () => {
  if (!fs.existsSync(instRoot())) return;
  for (const id of fs.readdirSync(instRoot())) {
    let inst;
    try { inst = readInst(id); } catch { continue; }
    await instanceWork(id, () => history.clear(readInst(inst.id)));
  }
});
ipcMain.handle('crashes:list', (id) => diagnostics.list(id));
ipcMain.handle('crashes:open', ({ id, key }) => shell.openPath(diagnostics.report(id, key).file));
ipcMain.handle('crashes:copy', ({ id, key }) => {
  clipboard.writeText(diagnostics.report(id, key).text);
});
ipcMain.handle('crashes:installDependency', ({ id, key }) => instanceWork(id, async () => {
  const crash = (await diagnostics.list(id)).find((item) => item.key === key && item.type === 'dependency');
  if (!crash?.mod?.versionId || !/^[a-z0-9_.-]{2,64}$/i.test(crash.dependency || '')) return false;
  const inst = readInst(id);
  const version = await getJson(`${MR}/version/${encodeURIComponent(crash.mod.versionId)}`);
  const projectIds = (version.dependencies || []).filter((d) => d.dependency_type === 'required' && /^[a-z0-9]{4,32}$/i.test(d.project_id || ''))
    .map((d) => d.project_id).filter((projectId) => !inst.mods.some((mod) => mod.projectId === projectId));
  if (!projectIds.length) return false;
  const projects = await getJson(`${MR}/projects?ids=${encodeURIComponent(JSON.stringify(projectIds))}`);
  const alias = crash.dependency.toLowerCase().replace(/_/g, '-');
  const candidates = projects.filter((p) => projectIds.includes(p.id) && (p.slug === alias || (alias === 'fabric' && p.slug === 'fabric-api')));
  if (candidates.length !== 1) return false;
  await installProject(inst, candidates[0].id, false, 'mod');
  packChanged(id);
  return true;
}));

function keybindTarget(id) {
  if (typeof id !== 'string' || id !== safeName(id) || id === '.' || id === '..') throw new Error('Ungültige Instanz.');
  return { file: path.join(instDir(id), 'options.txt'), mc: readInst(id).mc };
}

ipcMain.handle('instances:keybinds:get', (id) => {
  const { file, mc } = keybindTarget(id);
  return bindings(file, mc);
});

ipcMain.handle('instances:keybinds:save', async (change) => {
  const active = await runningModstackInstances();
  if (active.some((id) => id.toLowerCase() === String(change.id).toLowerCase())) {
    throw new Error('Schließe Minecraft für diese Instanz, bevor du die Tastenbelegung speicherst.');
  }
  const { file, mc } = keybindTarget(change.id);
  writeBinding(file, mc, change);
  return bindings(file, mc);
});
const conc = () => Math.max(1, Math.min(12, appSettings().downloads || 6));

ipcMain.handle('mr:project', async ({ id, projectId, kind, file }) => {
  const inst = readInst(id);
  const installed = file && inst.mods.find((m) => m.file === file && kindOf(m) === kind);
  if (file && !installed) return null;
  if (installed) {
    projectId = installed.projectId;
    if (!projectId) {
      const source = entryPath(id, installed);
      const base = instDir(id);
      const folder = path.dirname(source);
      if (fs.lstatSync(base, { throwIfNoEntry: false })?.isDirectory() &&
          fs.lstatSync(folder, { throwIfNoEntry: false })?.isDirectory() &&
          fs.lstatSync(source, { throwIfNoEntry: false })?.isFile()) {
        const hash = crypto.createHash('sha1');
        for await (const chunk of fs.createReadStream(source)) hash.update(chunk);
        const response = await fetch(`${MR}/version_file/${hash.digest('hex')}?algorithm=sha1`, {
          headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000),
        });
        if (response.ok) projectId = (await response.json()).project_id;
        else if (response.status !== 404) throw new Error('Modrinth konnte die Datei gerade nicht zuordnen. Bitte versuche es erneut.');
      }
      if (!projectId) return null;
    }
  }
  if (typeof projectId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(projectId)) throw new Error('Ungültiges Modrinth-Projekt.');
  const slug = encodeURIComponent(projectId);
  const params = new URLSearchParams({ game_versions: JSON.stringify([inst.mc]), include_changelog: 'false' });
  if (kind === 'mod') params.set('loaders', JSON.stringify(loaderList(inst)));
  const signal = AbortSignal.timeout(8000);
  const [project, versions] = await Promise.all([
    getJson(`${MR}/project/${slug}`, signal),
    getJson(`${MR}/project/${slug}/version?${params}`, signal).catch(() => null),
  ]);
  const media = (url) => typeof url === 'string' && /^https:\/\/cdn\.modrinth\.com\//.test(url) ? url : '';
  return {
    title: String(project.title || '').slice(0, 100), summary: String(project.description || '').slice(0, 500),
    description: String(project.body || '').slice(0, 16000), icon: media(project.icon_url),
    gallery: (project.gallery || []).slice(0, 6).map((item) => media(item.url)).filter(Boolean),
    downloads: project.downloads, versions: versions?.slice(0, 15).map((v) => ({ version: v.version_number, channel: v.version_type })),
    url: 'https://modrinth.com/project/' + slug,
  };
});

async function latestVersion(inst, projectId, kind) {
  let url = `${MR}/project/${projectId}/version?game_versions=${encodeURIComponent(JSON.stringify([inst.mc]))}`;
  if ((kind || 'mod') === 'mod') url += `&loaders=${encodeURIComponent(JSON.stringify(loaderList(inst)))}`;
  const vs = await getJson(url);
  if (appSettings().allowBeta) return vs[0] || null; // neueste zuerst
  return vs.find((v) => v.version_type === 'release') || vs[0] || null; // stabile bevorzugt
}

async function installProject(inst, projectId, isDep, kind, warnings) {
  kind = kind || 'mod';
  if (inst.mods.some((m) => m.projectId === projectId)) return;
  const v = await latestVersion(inst, projectId, kind);
  if (!v) {
    if (isDep) { status(`Abhaengigkeit ${projectId}: keine passende Version, uebersprungen`); return; }
    throw new Error('Keine passende Version fuer ' + inst.mc + (kind === 'mod' ? ' / ' + inst.loader : ''));
  }
  const proj = await getJson(`${MR}/project/${projectId}`);
  // Konflikt mit installierten Mods?
  const clash = (v.dependencies || []).filter((d) => d.dependency_type === 'incompatible' && d.project_id && inst.mods.some((m) => m.projectId === d.project_id));
  for (const c of clash) warnings && warnings.push(`${proj.title} ist laut Autor inkompatibel mit ${inst.mods.find((m) => m.projectId === c.project_id).title}`);
  const f = v.files.find((x) => x.primary) || v.files[0];
  status('Lade ' + proj.title + ' ...');
  await downloadModrinth(f, path.join(instDir(inst.id), KIND_DIR[kind], modFile(f.filename)));
  inst.mods.push({ file: f.filename, projectId, versionId: v.id, title: proj.title, icon: proj.icon_url || undefined, kind, version: v.version_number });
  saveInst(inst);
  if (kind === 'mod' && appSettings().autoDeps !== false) {
    for (const d of v.dependencies || []) {
      if (d.dependency_type === 'required' && d.project_id) await installProject(inst, d.project_id, true, 'mod', warnings);
    }
  }
}

ipcMain.handle('mr:install', ({ id, projectId, kind }) => instanceWork(id, async () => {
  const inst = readInst(id);
  const warnings = [];
  await installProject(inst, projectId, false, kind, warnings);
  packChanged(id);
  status(warnings.length ? 'Installiert, aber: ' + warnings.join('; ') : 'Fertig');
  return { inst: readInst(id), warnings };
}));

// Prueft alle Modrinth-Eintraege einer Instanz; meldet nur echte Updates (neuer als die installierte Version)
async function checkInst(inst, quiet) {
  const managed = inst.sync?.role === 'member' && appSettings().packSync !== false ? new Set(inst.sync.managed || []) : new Set();
  const list = inst.mods.filter((m) => m.projectId && m.versionId && !managed.has(m.projectId));
  if (!list.length) return [];
  const dates = {};
  for (let i = 0; i < list.length; i += 100) {
    try { for (const v of await getJson(`${MR}/versions?ids=${encodeURIComponent(JSON.stringify(list.slice(i, i + 100).map((m) => m.versionId)))}`)) dates[v.id] = v.date_published; } catch {}
  }
  const res = [];
  let n = 0;
  await pool(list, conc(), async (m) => {
    try {
      const v = await latestVersion(inst, m.projectId, kindOf(m));
      if (v && v.id !== m.versionId && (!dates[m.versionId] || new Date(v.date_published) > new Date(dates[m.versionId]))) {
        res.push({ projectId: m.projectId, title: m.title, from: m.version || '', to: v.version_number, versionId: v.id });
      }
    } catch {}
    if (!quiet) status(`Pruefe Updates ${++n}/${list.length} ...`);
  });
  return res;
}

async function downloadModrinth(file, dest) {
  const url = new URL(file.url);
  const checksum = file.hashes?.sha1;
  if (url.origin !== 'https://cdn.modrinth.com' || url.username || url.password || !/^[a-f\d]{40}$/i.test(checksum || '')) {
    throw new Error('Die Modrinth-Datei hat keine gültige Download-Adresse oder Prüfsumme.');
  }
  const response = await fetch(url, { redirect: 'error', headers: { 'User-Agent': UA } });
  if (!response.ok) throw new Error('Download fehlgeschlagen (' + response.status + ')');
  const payload = Buffer.from(await response.arrayBuffer());
  if (crypto.createHash('sha1').update(payload).digest('hex') !== checksum.toLowerCase()) throw new Error('Die Prüfsumme der Modrinth-Datei stimmt nicht.');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, payload, { flag: 'wx' });
}

async function applyUpdate(id, old, version) {
  const file = version.files?.find((x) => x.primary) || version.files?.[0];
  if (!file || version.project_id !== old.projectId) throw new Error('Die Version gehört nicht zum installierten Mod.');
  const next = { ...old, file: modFile(file.filename), versionId: version.id, version: version.version_number };
  const stage = path.join(instDir(id), '.download-' + crypto.randomUUID());
  try {
    await downloadModrinth(file, stage);
    const inst = readInst(id);
    const current = inst.mods.find((item) => item.projectId === old.projectId && item.versionId === old.versionId && item.file === old.file);
    if (!current) throw new Error('Der Mod wurde inzwischen geändert.');
    history.replace(inst, current, { ...next, disabled: current.disabled }, stage);
  } finally { fs.rmSync(stage, { force: true }); }
}

ipcMain.handle('mr:checkUpdates', async (id) => checkInst(readInst(id)));

ipcMain.handle('mr:checkAll', async () => {
  const out = {};
  fs.mkdirSync(instRoot(), { recursive: true });
  for (const d of fs.readdirSync(instRoot())) {
    let inst; try { inst = readJson(path.join(instRoot(), d, 'instance.json')); } catch { continue; }
    try { out[inst.id] = await checkInst(inst, true); } catch { out[inst.id] = []; }
  }
  return out;
});

ipcMain.handle('mr:updateOne', ({ id, projectId }) => instanceWork(id, async () => {
  const inst = readInst(id);
  const m = inst.mods.find((x) => x.projectId === projectId);
  if (!m) throw new Error('Mod nicht gefunden');
  const v = await latestVersion(inst, projectId, kindOf(m));
  if (!v || v.id === m.versionId) { status('Schon aktuell'); return inst; }
  await backups.beforeUpdate(id);
  status('Aktualisiere ' + m.title + ' ...');
  await applyUpdate(id, m, v);
  packChanged(id);
  status(m.title + ' aktualisiert auf ' + v.version_number);
  return readInst(id);
}));

ipcMain.handle('mr:updateAll', (id) => instanceWork(id, async () => {
  const inst = readInst(id);
  const ups = await checkInst(inst, true);
  if (ups.length) await backups.beforeUpdate(id);
  let count = 0;
  const failed = [];
  for (const [index, u] of ups.entries()) {
    status(`Aktualisiere ${index + 1}/${ups.length} ...`);
    const m = inst.mods.find((x) => x.projectId === u.projectId);
    if (!m) continue;
    try { await applyUpdate(id, m, await getJson(`${MR}/version/${encodeURIComponent(u.versionId)}`)); count++; }
    catch (error) { failed.push(m.title + ': ' + error.message); }
  }
  status(count + ' Einträge aktualisiert' + (failed.length ? ' · ' + failed.join(' · ') : ''));
  if (count) packChanged(id);
  return readInst(id);
}));

ipcMain.handle('mr:checkConflicts', async (id) => {
  const inst = readInst(id);
  const mods = inst.mods.filter((m) => m.versionId && kindOf(m) === 'mod' && !m.disabled);
  if (!mods.length) return [];
  const vs = await getJson(`${MR}/versions?ids=${encodeURIComponent(JSON.stringify(mods.map((m) => m.versionId)))}`);
  const byProj = new Map(inst.mods.filter((m) => m.projectId && !m.disabled).map((m) => [m.projectId, m]));
  const out = [];
  const missing = new Set();
  for (const v of vs) {
    const me = mods.find((m) => m.versionId === v.id);
    for (const d of v.dependencies || []) {
      if (!d.project_id) continue;
      if (d.dependency_type === 'incompatible' && byProj.has(d.project_id)) out.push(`${me.title} ist inkompatibel mit ${byProj.get(d.project_id).title}`);
      if (d.dependency_type === 'required' && !byProj.has(d.project_id)) missing.add(d.project_id + '|' + me.title);
    }
  }
  if (missing.size) {
    const ids = [...new Set([...missing].map((x) => x.split('|')[0]))];
    let names = {};
    try { for (const p of await getJson(`${MR}/projects?ids=${encodeURIComponent(JSON.stringify(ids))}`)) names[p.id] = p.title; } catch {}
    for (const x of missing) {
      const [pid, who] = x.split('|');
      // Manuell/CurseForge installierte Mods koennten die Abhaengigkeit schon liefern; nur Hinweis
      out.push(`${who} braucht ${names[pid] || pid}, das fehlt (oder ist manuell installiert)`);
    }
  }
  return out;
});

// Nachtraeglich Modrinth-Infos zu Dateien finden (fuer Updates, Icons, Titel)
async function linkModrinth(inst, entries) {
  const withHash = entries.filter((e) => e.sha1 && !e.m.projectId);
  if (!withHash.length) return;
  let map = {};
  try {
    const r = await fetch(`${MR}/version_files`, { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/json' }, body: JSON.stringify({ hashes: withHash.map((e) => e.sha1), algorithm: 'sha1' }) });
    if (r.ok) map = await r.json();
  } catch { return; }
  const pids = [...new Set(Object.values(map).map((v) => v.project_id))];
  const projs = {};
  for (let i = 0; i < pids.length; i += 100) {
    try { for (const p of await getJson(`${MR}/projects?ids=${encodeURIComponent(JSON.stringify(pids.slice(i, i + 100)))}`)) projs[p.id] = p; } catch {}
  }
  for (const e of withHash) {
    const v = map[e.sha1];
    if (!v) continue;
    e.m.projectId = v.project_id; e.m.versionId = v.id; e.m.version = v.version_number;
    const p = projs[v.project_id];
    if (p) { e.m.title = p.title; if (p.icon_url) e.m.icon = p.icon_url; }
    delete e.m.manual;
  }
}

ipcMain.handle('mods:remove', ({ id, file }) => instanceWork(id, () => {
  const inst = readInst(id);
  const m = inst.mods.find((x) => x.file === file);
  if (m) { history.replace(inst, m, null, null); packChanged(id); }
  return readInst(id);
}));

ipcMain.handle('mods:toggle', ({ id, file }) => {
  const inst = readInst(id);
  const m = inst.mods.find((x) => x.file === file);
  if (!m) throw new Error('Eintrag nicht gefunden');
  const from = entryPath(id, m);
  m.disabled = !m.disabled;
  const to = entryPath(id, m);
  if (fs.existsSync(from)) fs.renameSync(from, to);
  saveInst(inst);
  packChanged(id);
  return inst;
});

ipcMain.handle('mods:addFiles', ({ id, paths }) => instanceWork(id, async () => {
  const inst = readInst(id);
  const added = [];
  for (const p of paths) {
    if (!/\.(jar|zip)$/i.test(p)) continue;
    const name = path.basename(p);
    const data = fs.readFileSync(p);
    const folder = targetFolder(name, data);
    const kind = Object.keys(KIND_DIR).find((k) => KIND_DIR[k] === folder) || 'mod';
    fs.mkdirSync(path.join(instDir(id), folder), { recursive: true });
    fs.writeFileSync(path.join(instDir(id), folder, name), data);
    if (!inst.mods.some((m) => m.file === name)) {
      const m = { file: name, title: name.replace(/\.(jar|zip)$/i, ''), manual: true, kind };
      inst.mods.push(m);
      added.push({ m, sha1: crypto.createHash('sha1').update(data).digest('hex') });
    }
  }
  status('Suche Infos auf Modrinth ...');
  await linkModrinth(inst, added);
  saveInst(inst);
  packChanged(id);
  status(added.length + ' Datei(en) hinzugefuegt');
  return inst;
}));

// ---------- Instanz-Extras ----------
ipcMain.handle('instances:duplicate', (id) => {
  const inst = readInst(id);
  const name = inst.name + ' (Kopie)';
  let nid = safeName(name), n = 1;
  while (fs.existsSync(instDir(nid))) nid = safeName(name) + '_' + ++n;
  fs.cpSync(instDir(id), instDir(nid), { recursive: true });
  const copy = { ...inst, id: nid, name, sync: undefined };
  if (Array.isArray(copy.history)) copy.history = copy.history.filter((item) => !item.config);
  saveInst(copy);
  return copy;
});

ipcMain.handle('instances:settings', (p) => {
  const inst = readInst(p.id);
  if ('ram' in p) inst.ram = instanceRam(p.ram);
  if ('javaArgs' in p) inst.javaArgs = instanceJavaArgs(p.javaArgs);
  if ('resolution' in p) {
    const r = p.resolution;
    inst.resolution = r && r.width >= 320 && r.height >= 240 ? { width: Math.min(7680, r.width | 0), height: Math.min(4320, r.height | 0) } : undefined;
  }
  if ('notes' in p) inst.notes = String(p.notes || '').slice(0, 2000) || undefined;
  saveInst(inst);
  return inst;
});

ipcMain.handle('instances:setIcon', ({ id, icon, iconGen }) => {
  const inst = readInst(id);
  if (icon) {
    if (!/^data:image\/(png|jpeg|webp|gif|svg\+xml)[;,]/.test(icon) || icon.length > 400000) throw new Error('Bild ungueltig oder zu gross');
    inst.icon = icon;
  } else delete inst.icon;
  if (iconGen && typeof iconGen.i === 'string') inst.iconGen = { i: iconGen.i.slice(0, 20), p: String(iconGen.p || '').slice(0, 20) };
  else delete inst.iconGen;
  saveInst(inst);
  return inst;
});

const SUBDIRS = { root: '', mods: 'mods', saves: 'saves', screenshots: 'screenshots', resourcepacks: 'resourcepacks', shaderpacks: 'shaderpacks', config: 'config', logs: 'logs' };
ipcMain.handle('instances:openSub', ({ id, sub }) => {
  if (!(sub in SUBDIRS)) throw new Error('Unbekannter Ordner');
  const p = path.join(instDir(id), SUBDIRS[sub]);
  fs.mkdirSync(p, { recursive: true });
  shell.openPath(p);
  return true;
});

// Spielzeit aus Minecrafts eigenen Statistiken (saves/<Welt>/stats/<uuid>.json), in Ticks (20 pro Sekunde)
function worldStats(dir) {
  const saves = path.join(dir, 'saves');
  const out = [];
  let names = []; try { names = fs.readdirSync(saves, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch {}
  for (const w of names) {
    const wd = path.join(saves, w);
    let ticks = 0;
    try {
      for (const f of fs.readdirSync(path.join(wd, 'stats'))) {
        if (!f.endsWith('.json')) continue;
        try {
          const j = readJson(path.join(wd, 'stats', f));
          const cst = (j.stats && j.stats['minecraft:custom']) || {};
          ticks += cst['minecraft:play_time'] || cst['minecraft:play_one_minute'] || j['stat.playOneMinute'] || 0;
        } catch {}
      }
    } catch {}
    let last = null; try { last = fs.statSync(path.join(wd, 'level.dat')).mtime; } catch {}
    out.push({ name: w, ticks, lastPlayed: last });
  }
  return out.sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0));
}

ipcMain.handle('instances:details', (id) => {
  const dir = instDir(id);
  const worlds = worldStats(dir);
  const count = (sub, re) => { try { return fs.readdirSync(path.join(dir, sub)).filter((f) => !re || re.test(f)).length; } catch { return 0; } };
  return { ticks: playtime.ticks(id, worlds.reduce((s, w) => s + w.ticks, 0)), worlds, screenshots: count('screenshots', /\.png$/i), bytes: dirSize(dir) };
});

ipcMain.handle('instances:playtimes', () => {
  const out = {};
  try { for (const d of fs.readdirSync(instRoot())) out[d] = playtime.ticks(d, legacyPlaytime(d)); } catch {}
  return out;
});

const legacyPlaytime = (id) => worldStats(instDir(id)).reduce((s, w) => s + w.ticks, 0);
const playtime = require('./instance-playtime')({
  file: path.join(app.getPath('userData'), 'instance-playtime.json'),
  running: runningModstackInstances, legacyTicks: legacyPlaytime,
  enabled: () => appSettings().trackPlaytime !== false,
  resolveId(id) { try { return readInst(id).id; } catch { return null; } },
  onSample(active) { if (hiddenForGame && !active.length) app.quit(); },
});
ipcMain.handle('playtime:active', () => playtime.sample());

ipcMain.handle('instances:info', (id) => {
  const dir = instDir(id);
  const count = (sub, re) => { try { return fs.readdirSync(path.join(dir, sub)).filter((f) => !re || re.test(f)).length; } catch { return 0; } };
  let created = null; try { created = fs.statSync(path.join(dir, 'instance.json')).birthtime; } catch {}
  return { bytes: dirSize(dir), worlds: count('saves'), screenshots: count('screenshots', /\.png$/i), created, path: dir };
});

// ---------- App-Einstellungen, Konto, News ----------
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function saveAppSettings(patch) {
  const s = { ...appSettings(), ...patch };
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
  return s;
}
ipcMain.handle('settings:get', appSettings);
ipcMain.handle('settings:set', saveAppSettings);
ipcMain.handle('settings:keybinds:get', () => presetBindings(appSettings().defaultKeybinds));
ipcMain.handle('settings:keybinds:save', (change) => {
  const defaultKeybinds = savePresetBinding(appSettings().defaultKeybinds, change);
  saveAppSettings({ defaultKeybinds });
  return presetBindings(defaultKeybinds);
});
ipcMain.handle('settings:minecraft-option:set', (change) => {
  const defaultMinecraftOptions = updateOptionDefaults(appSettings().defaultMinecraftOptions, change);
  return saveAppSettings({ defaultMinecraftOptions });
});

// Eigenes Hintergrundbild: wird in den Datenordner kopiert und als data-URL geliefert
const BG_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
function bgFile() {
  for (const e of Object.keys(BG_EXT)) { const p = path.join(app.getPath('userData'), 'background' + e); if (fs.existsSync(p)) return p; }
  return null;
}
const bgData = (p) => 'data:' + BG_EXT[path.extname(p).toLowerCase()] + ';base64,' + fs.readFileSync(p).toString('base64');
ipcMain.handle('bg:get', () => { const p = bgFile(); return p ? bgData(p) : null; });
ipcMain.handle('bg:pick', async () => {
  const res = await dialog.showOpenDialog(win, { title: 'Hintergrundbild waehlen', filters: [{ name: 'Bilder', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }], properties: ['openFile'] });
  if (res.canceled || !res.filePaths.length) return null;
  const src = res.filePaths[0];
  const ext = path.extname(src).toLowerCase();
  if (!BG_EXT[ext]) throw new Error('Dateityp nicht unterstuetzt');
  if (fs.statSync(src).size > 20 * 1048576) throw new Error('Bild ist zu gross (max. 20 MB)');
  return bgData(src);
});
ipcMain.handle('bg:save', (image) => {
  const match = typeof image === 'string' && /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+=*)$/.exec(image);
  if (!match) throw new Error('Bild ungueltig');
  const data = Buffer.from(match[2], 'base64');
  if (!data.length || data.length > 20 * 1048576) throw new Error('Bild ist ungueltig oder zu gross (max. 20 MB)');
  const ext = Object.keys(BG_EXT).find((key) => BG_EXT[key] === match[1]);
  const old = bgFile();
  const dir = app.getPath('userData');
  const dest = path.join(dir, 'background' + ext);
  const temp = dest + '.tmp';
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(temp, data);
    fs.renameSync(temp, dest);
  } finally {
    fs.rmSync(temp, { force: true });
  }
  if (old && old !== dest) fs.rmSync(old, { force: true });
  return true;
});
ipcMain.handle('bg:clear', () => { const p = bgFile(); if (p) fs.rmSync(p, { force: true }); return true; });

// Liest nur Name und UUID des aktiven Kontos aus dem offiziellen Launcher (keine Tokens)
function readMinecraftAccount() {
  const dirs = [mcDir(), path.join(process.env.LOCALAPPDATA || '', 'Packages', 'Microsoft.4297127D64EC6_8wekyb3d8bbwe', 'LocalCache', 'Roaming', '.minecraft')];
  for (const d of dirs) {
    for (const f of ['launcher_accounts_microsoft_store.json', 'launcher_accounts.json']) {
      try {
        const j = readJson(path.join(d, f));
        const acc = (j.accounts || {})[j.activeAccountLocalId] || Object.values(j.accounts || {})[0];
        if (acc && acc.minecraftProfile && acc.minecraftProfile.name) return { name: acc.minecraftProfile.name, uuid: acc.minecraftProfile.id };
      } catch {}
    }
  }
  return null;
}
ipcMain.handle('mc:account', readMinecraftAccount);

// Skin + Umhang als data-URL (oeffentliche Mojang-Profil-API, kein Login noetig)
const skinCache = new Map();
ipcMain.handle('mc:skin', async ({ uuid, name }) => {
  const key = (uuid || name || '').toLowerCase();
  if (!key) return null;
  if (skinCache.has(key)) return skinCache.get(key);
  let id = uuid;
  if (!id) {
    const r = await fetch('https://api.mojang.com/users/profiles/minecraft/' + encodeURIComponent(name), { headers: { 'User-Agent': UA } });
    if (!r.ok) return null;
    id = (await r.json()).id;
  }
  const prof = await getJson('https://sessionserver.mojang.com/session/minecraft/profile/' + encodeURIComponent(String(id).replace(/-/g, '')));
  const prop = (prof.properties || []).find((p) => p.name === 'textures');
  if (!prop) return null;
  const tex = JSON.parse(Buffer.from(prop.value, 'base64').toString('utf8')).textures || {};
  const toData = async (u) => {
    if (!u) return null;
    const url = u.replace(/^http:/, 'https:');
    if (!/^https:\/\/textures\.minecraft\.net\//.test(url)) return null;
    return 'data:image/png;base64,' + (await fetchBuf(url)).toString('base64');
  };
  const out = {
    name: prof.name,
    slim: !!(tex.SKIN && tex.SKIN.metadata && tex.SKIN.metadata.model === 'slim'),
    skin: await toData(tex.SKIN && tex.SKIN.url),
    cape: await toData(tex.CAPE && tex.CAPE.url),
  };
  skinCache.set(key, out);
  return out;
});

let newsCache = null;
ipcMain.handle('mc:news', async () => {
  if (newsCache && Date.now() - newsCache.t < 30 * 60000) return newsCache.d;
  const base = 'https://launchercontent.mojang.com';
  const j = await getJson(base + '/v2/news.json');
  const d = (j.entries || [])
    .filter((e) => (e.newsType || []).includes('Java'))
    .slice(0, 8)
    .map((e) => ({ title: e.title, text: e.text, date: e.date, link: e.readMoreLink, image: e.playPageImage ? base + e.playPageImage.url : e.newsPageImage ? base + e.newsPageImage.url : null }));
  newsCache = { t: Date.now(), d };
  return d;
});

ipcMain.handle('settings:reset', () => { fs.rmSync(settingsFile(), { force: true }); return {}; });

ipcMain.handle('app:clearCache', async () => {
  newsCache = null; skinCache.clear();
  let n = 0;
  const tmp = app.getPath('temp');
  for (const f of fs.readdirSync(tmp)) {
    if (/^(neo)?forge-.*-installer\.jar$/i.test(f)) { try { fs.rmSync(path.join(tmp, f), { force: true }); n++; } catch {} }
  }
  if (win) await win.webContents.session.clearCache();
  return n;
});

function dirSize(p) {
  let s = 0;
  try {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const q = path.join(p, e.name);
      if (e.isDirectory()) s += dirSize(q); else { try { s += fs.statSync(q).size; } catch {} }
    }
  } catch {}
  return s;
}
ipcMain.handle('app:diskUsage', () => {
  fs.mkdirSync(instRoot(), { recursive: true });
  return fs.readdirSync(instRoot()).map((d) => {
    let name = d; try { name = readJson(path.join(instRoot(), d, 'instance.json')).name; } catch {}
    return { id: d, name, bytes: dirSize(path.join(instRoot(), d)) };
  }).sort((a, b) => b.bytes - a.bytes);
});

ipcMain.handle('win:zoomSet', (factor) => { const f = Math.max(0.7, Math.min(1.6, +factor || 1)); win.webContents.setZoomFactor(f); return f; });

ipcMain.handle('sys:info', () => ({ totalMb: Math.floor(require('os').totalmem() / 1048576) }));

// ---------- ZIP lesen (ohne Fremdbibliothek) ----------
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Keine gueltige ZIP-Datei');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const loc = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8').replace(/\\/g, '/');
    p += 46 + nlen + xlen + clen;
    entries.push({
      name,
      dir: name.endsWith('/'),
      data: (maxBytes) => {
        const start = loc + 30 + buf.readUInt16LE(loc + 26) + buf.readUInt16LE(loc + 28);
        const raw = buf.slice(start, start + csize);
        if (maxBytes && method === 0 && raw.length > maxBytes) throw new Error('ZIP-Eintrag zu groß.');
        if (method === 0) return raw;
        if (method === 8) return zlib.inflateRawSync(raw, maxBytes ? { maxOutputLength: maxBytes } : undefined);
        throw new Error('ZIP-Kompression nicht unterstuetzt: ' + name);
      },
    });
  }
  return entries;
}

// ---------- CurseForge-Import ----------
const CFW = 'https://www.curseforge.com/api/v1/mods';

async function fetchBuf(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}

function parseLoader(id) {
  // z.B. "forge-47.2.0", "neoforge-21.1.77", "fabric-0.15.7", "quilt-0.26.0"
  const m = /^(neoforge|forge|fabric|quilt)-(.+)$/i.exec(id || '');
  if (!m) return null;
  return { loader: m[1].toLowerCase(), version: m[2] };
}

function cfTitle(info) {
  // displayName ist oft nur eine Versionsnummer; dann den Dateinamen nehmen
  const dn = info.displayName || '';
  if (/[a-z]{3,}/i.test(dn.replace(/\b(for|fabric|forge|neoforge|quilt|mc|minecraft)\b/gi, ''))) return dn;
  return String(info.fileName || dn).replace(/\.(jar|zip)$/i, '');
}

function targetFolder(fileName, data) {
  if (fileName.toLowerCase().endsWith('.jar')) return 'mods';
  try {
    const names = readZip(data).map((e) => e.name);
    if (names.some((n) => /^shaders\//i.test(n))) return 'shaderpacks';
    if (names.some((n) => /^pack\.mcmeta$/i.test(n))) return 'resourcepacks';
  } catch {}
  return 'mods';
}

async function pool(items, size, fn) {
  let i = 0;
  const work = async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, work));
}

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
const folderKind = (folder) => Object.keys(KIND_DIR).find((k) => KIND_DIR[k] === folder) || null;

function newInstId(name) {
  let id = safeName(name), n = 1;
  while (fs.existsSync(instDir(id))) id = safeName(name) + '_' + ++n;
  return id;
}

// Kopiert Override-Ordner ins Instanzverzeichnis; gibt Mods/Packs darin fuer Modrinth-Verknuepfung zurueck
function extractOverrides(entries, prefixes, inst) {
  const dir = path.resolve(instDir(inst.id));
  const found = [];
  for (const pre of prefixes) {
    const ov = pre.replace(/\/+$/, '') + '/';
    for (const e of entries) {
      if (e.dir || !e.name.startsWith(ov)) continue;
      const rel = e.name.slice(ov.length);
      const dest = path.resolve(dir, rel);
      if (!rel || !dest.startsWith(dir + path.sep)) continue;
      const data = e.data();
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, data);
      const mm = /^(mods|resourcepacks|shaderpacks)\/([^/]+\.(jar|zip))$/i.exec(rel);
      if (mm && !inst.mods.some((x) => x.file === mm[2])) {
        const m = { file: mm[2], title: mm[2].replace(/\.(jar|zip)$/i, ''), manual: true, kind: folderKind(mm[1].toLowerCase()) };
        inst.mods.push(m);
        found.push({ m, sha1: sha1(data) });
      }
    }
  }
  return found;
}

// ---------- Modrinth-Modpacks (.mrpack) ----------
async function importMrpack(buf, fallbackName, extra) {
  const entries = readZip(buf);
  const ie = entries.find((e) => e.name === 'modrinth.index.json');
  if (!ie) throw new Error('Keine modrinth.index.json gefunden. Ist das eine .mrpack-Datei?');
  const idx = JSON.parse(ie.data().toString('utf8'));
  const dep = idx.dependencies || {};
  const mc = dep.minecraft;
  if (!mc) throw new Error('Modpack enthaelt keine Minecraft-Version');
  let loader = null, loaderVersion;
  for (const [k, l] of [['fabric-loader', 'fabric'], ['quilt-loader', 'quilt'], ['neoforge', 'neoforge'], ['forge', 'forge']]) {
    if (dep[k]) { loader = l; loaderVersion = dep[k]; break; }
  }
  if (!loader) throw new Error('Modpack ohne unterstuetzten Loader (nur Fabric, Quilt, Forge, NeoForge)');
  const name = idx.name || fallbackName || 'Modpack';
  const id = newInstId(name);
  fs.mkdirSync(path.join(instDir(id), 'mods'), { recursive: true });
  const inst = { id, name, mc, loader, loaderVersion, mods: [], source: 'modrinth', ...(extra || {}) };

  const dir = path.resolve(instDir(id));
  const files = (idx.files || []).filter((f) => !(f.env && f.env.client === 'unsupported'));
  const failed = [], linkable = [];
  let done = 0;
  await pool(files, conc(), async (f) => {
    try {
      const dest = path.resolve(dir, f.path);
      if (!dest.startsWith(dir + path.sep)) throw new Error('ungueltiger Pfad');
      const url = (f.downloads || [])[0];
      if (!url) throw new Error('kein Download-Link');
      await download(url, dest, f.hashes && f.hashes.sha1);
      const mm = /^(mods|resourcepacks|shaderpacks)\/([^/]+)$/i.exec(f.path.replace(/\\/g, '/'));
      if (mm) {
        const m = { file: mm[2], title: mm[2].replace(/\.(jar|zip)$/i, ''), kind: folderKind(mm[1].toLowerCase()) };
        inst.mods.push(m);
        if (f.hashes && f.hashes.sha1) linkable.push({ m, sha1: f.hashes.sha1 });
      }
    } catch (e) { failed.push(`${f.path}: ${e.message}`); }
    status(`Lade Modpack-Dateien ${++done}/${files.length} ...`);
  });
  linkable.push(...extractOverrides(entries, ['overrides', 'client-overrides'], inst));
  // Bild aus einem Modstack-Export uebernehmen
  const msj = entries.find((e) => e.name === 'modstack.json');
  if (msj) {
    try {
      const x = JSON.parse(msj.data().toString('utf8'));
      if (typeof x.icon === 'string' && x.icon.length < 400000 && /^(data:image\/(png|jpeg|webp|gif|svg\+xml)[;,]|https:\/\/cdn\.modrinth\.com\/)/.test(x.icon)) inst.icon = x.icon;
      if (x.iconGen && typeof x.iconGen.i === 'string') inst.iconGen = { i: x.iconGen.i.slice(0, 20), p: String(x.iconGen.p || '').slice(0, 20) };
    } catch {}
  }
  status('Hole Mod-Infos von Modrinth ...');
  await linkModrinth(inst, linkable);
  saveNewInst(inst);
  if (failed.length) {
    fs.writeFileSync(path.join(instDir(id), 'import-fehler.txt'), failed.join('\r\n'));
    status(`Modpack installiert, ${failed.length} Dateien fehlgeschlagen (import-fehler.txt)`);
  } else status(`Modpack installiert: ${files.length} Dateien`);
  return inst;
}

ipcMain.handle('mr:packVersions', async (projectId) => {
  const vs = await getJson(`${MR}/project/${projectId}/version`);
  return vs.map((v) => ({ id: v.id, name: v.name, number: v.version_number, mc: v.game_versions, loaders: v.loaders, type: v.version_type }));
});

ipcMain.handle('mr:installPack', async ({ projectId, versionId }) => {
  const proj = await getJson(`${MR}/project/${projectId}`);
  const v = versionId ? await getJson(`${MR}/version/${versionId}`) : (await getJson(`${MR}/project/${projectId}/version`))[0];
  if (!v) throw new Error('Keine Version gefunden');
  const f = v.files.find((x) => x.primary) || v.files[0];
  status('Lade Modpack ' + proj.title + ' ...');
  const r = await fetch(f.url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error('Download fehlgeschlagen (' + r.status + ')');
  const buf = Buffer.from(await r.arrayBuffer());
  return importMrpack(buf, proj.title, { icon: proj.icon_url || undefined, pack: { projectId, versionId: v.id, version: v.version_number } });
});

async function importProfileZip(buf, fallbackName) {
  const entries = readZip(buf);
  if (entries.some((e) => e.name === 'modrinth.index.json')) return importMrpack(buf, fallbackName);
  const me = entries.find((e) => e.name === 'manifest.json');
  if (!me) throw new Error('Keine manifest.json im Profil. Ist das ein CurseForge-Profil-Export?');
  const man = JSON.parse(me.data().toString('utf8').replace(/^﻿/, ''));
  const mc = man.minecraft && man.minecraft.version;
  if (!mc) throw new Error('Profil enthaelt keine Minecraft-Version');
  const ml = (man.minecraft.modLoaders || []).find((x) => x.primary) || (man.minecraft.modLoaders || [])[0];
  const pl = ml && parseLoader(ml.id);
  if (!pl) throw new Error('Unbekannter Mod-Loader im Profil: ' + (ml ? ml.id : 'keiner'));

  const name = man.name || fallbackName || 'CurseForge-Profil';
  const id = newInstId(name);
  const dir = instDir(id);
  fs.mkdirSync(path.join(dir, 'mods'), { recursive: true });
  const inst = { id, name, mc, loader: pl.loader, loaderVersion: pl.version, mods: [], source: 'curseforge' };

  const linkable = extractOverrides(entries, [(man.overrides || 'overrides')], inst);

  const files = man.files || [];
  const failed = [];
  let done = 0;
  await pool(files, conc(), async (f) => {
    try {
      const info = (await getJson(`${CFW}/${f.projectID}/files/${f.fileID}`)).data;
      const data = await fetchBuf(`${CFW}/${f.projectID}/files/${f.fileID}/download`);
      if (info.fileLength && data.length !== info.fileLength) throw new Error('Dateigroesse stimmt nicht');
      const folder = targetFolder(info.fileName, data);
      fs.mkdirSync(path.join(dir, folder), { recursive: true });
      fs.writeFileSync(path.join(dir, folder, path.basename(info.fileName)), data);
      const kind = folderKind(folder);
      if (kind) {
        const m = { file: path.basename(info.fileName), title: cfTitle(info), cf: { projectId: f.projectID, fileId: f.fileID }, kind };
        inst.mods.push(m);
        linkable.push({ m, sha1: sha1(data) });
      }
    } catch (e) {
      failed.push(`Projekt ${f.projectID} / Datei ${f.fileID}: ${e.message}`);
    }
    done++;
    status(`Lade CurseForge-Dateien ${done}/${files.length} ...`);
  });
  status('Verknuepfe mit Modrinth (fuer Updates und Icons) ...');
  await linkModrinth(inst, linkable);
  saveNewInst(inst);
  if (failed.length) {
    fs.writeFileSync(path.join(dir, 'import-fehler.txt'), failed.join('\r\n'));
    status(`Import fertig, ${failed.length} von ${files.length} Dateien fehlgeschlagen (Liste: import-fehler.txt im Instanzordner)`);
  } else {
    status(`Import fertig: ${files.length} Dateien`);
  }
  return inst;
}

ipcMain.handle('cf:importCode', async (code) => {
  const c = String(code || '').trim();
  if (!/^[A-Za-z0-9]{4,32}$/.test(c)) throw new Error('Ungueltiger Code');
  status('Hole Profil zum Code ...');
  const r = await fetch('https://api.curseforge.com/v1/shared-profile/' + encodeURIComponent(c), { headers: { 'User-Agent': UA } });
  if (r.status === 404) throw new Error('Code nicht gefunden. Codes sind nur 7 Tage gueltig.');
  if (!r.ok) throw new Error('CurseForge antwortet mit HTTP ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  return importProfileZip(buf, 'CurseForge ' + c);
});

ipcMain.handle('cf:importZip', async () => {
  const res = await dialog.showOpenDialog(win, { title: 'Modpack oder Profil waehlen', filters: [{ name: 'Modpack / Profil', extensions: ['zip', 'mrpack'] }], properties: ['openFile'] });
  if (res.canceled || !res.filePaths.length) return null;
  const p = res.filePaths[0];
  status('Lese ' + path.basename(p) + ' ...');
  return importProfileZip(fs.readFileSync(p), path.basename(p).replace(/\.(zip|mrpack)$/i, ''));
});

// ---------- Teilen ----------
// ZIP schreiben (Deflate), ohne Fremdbibliothek
const CRC_T = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
const crc32 = (b) => { let c = -1; for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function writeZip(files) { // files: [{name, data(Buffer)}]
  const parts = [], central = []; let off = 0;
  for (const f of files) {
    const name = Buffer.from(f.name.replace(/\\/g, '/'), 'utf8');
    const comp = zlib.deflateRawSync(f.data), crc = crc32(f.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(f.data.length, 22); lh.writeUInt16LE(name.length, 26);
    parts.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(f.data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
    central.push(ch, name);
    off += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}

// Loader-Version herausfinden, ohne etwas zu installieren
async function resolveLoaderVersion(inst) {
  if (inst.loaderVersion) return inst.loaderVersion;
  try {
    if (inst.loader === 'fabric' || inst.loader === 'quilt') {
      const base = inst.loader === 'fabric' ? 'https://meta.fabricmc.net/v2/versions/loader' : 'https://meta.quiltmc.org/v3/versions/loader';
      const list = await getJson(`${base}/${inst.mc}`);
      const pick = list.find((x) => x.loader && x.loader.stable !== false && !/beta|pre|rc/i.test(x.loader.version)) || list[0];
      return pick && pick.loader.version;
    }
    if (inst.loader === 'forge') { const p = (await getJson('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json')).promos; return p[inst.mc + '-recommended'] || p[inst.mc + '-latest']; }
    if (inst.loader === 'neoforge') {
      const parts = inst.mc.split('.'); const prefix = parts[0] === '1' ? `${parts[1]}.${parts[2] || '0'}.` : `${parts[0]}.${parts[1] || '0'}.`;
      const all = ((await getJson('https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge')).versions || []).filter((x) => x.startsWith(prefix));
      const st = all.filter((x) => !/beta|alpha/i.test(x)); return (st.length ? st : all).slice(-1)[0];
    }
  } catch {}
  return null;
}

// Teilen-Code: Name, Version, Loader und die Modrinth-Versionen, komprimiert. Kein Server noetig.
function buildShareCode(id, iconLimit = 1900) {
  const inst = readInst(id);
  const pick = (k) => inst.mods.filter((m) => m.versionId && kindOf(m) === k && !m.disabled).map((m) => m.versionId);
  const data = { n: inst.name, mc: inst.mc, l: inst.loader, lv: inst.loaderVersion || undefined, m: pick('mod'), r: pick('resourcepack'), s: pick('shader') };
  if (inst.iconGen) data.ig = inst.iconGen;
  if (inst.icon && /^https:\/\/cdn\.modrinth\.com\//.test(inst.icon) && inst.icon.length < 300) data.ic = inst.icon;
  const enc = () => 'MS1-' + zlib.deflateRawSync(Buffer.from(JSON.stringify(data)), { level: 9 }).toString('base64url');
  // Der kopierbare Code bleibt Discord-tauglich. Im internen Chat passt ein größeres Paket.
  let iconInCode = !inst.icon || !inst.icon.startsWith('data:image');
  if (!iconInCode) {
    for (const [px, q] of [[48, 75], [40, 70], [32, 65], [24, 60]]) {
      try { data.ii = nativeImage.createFromDataURL(inst.icon).resize({ width: px, height: px, quality: 'best' }).toJPEG(q).toString('base64'); } catch { delete data.ii; break; }
      if (enc().length <= iconLimit) { iconInCode = true; break; }
      delete data.ii;
    }
  }
  const code = enc();
  const skipped = inst.mods.filter((m) => !m.versionId && !m.disabled).map((m) => m.title);
  return { code, name: inst.name, included: data.m.length + data.r.length + data.s.length, skipped, iconInCode };
}
ipcMain.handle('share:code', buildShareCode);

ipcMain.handle('share:importCode', async (code) => {
  const m = /^MS1-([A-Za-z0-9_-]+)$/.exec(String(code || '').trim().replace(/\s+/g, ''));
  if (!m || m[1].length > 350000) throw new Error('Das ist kein gueltiger Modstack-Code');
  let d; try { d = JSON.parse(zlib.inflateRawSync(Buffer.from(m[1], 'base64url'), { maxOutputLength: 1048576 }).toString('utf8')); } catch { throw new Error('Code ist beschaedigt oder unvollstaendig'); }
  const safeVersion = (v) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.+\-]{0,63}$/.test(v);
  if (!d || !safeVersion(d.mc) || (d.lv != null && !safeVersion(d.lv)) || !LOADERS.includes(d.l)) {
    throw new Error('Code enthaelt keine gueltige Version');
  }
  if ([d.m, d.r, d.s].some((ids) => ids != null && (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id))))) {
    throw new Error('Code enthaelt ungueltige Dateien');
  }
  const id = newInstId(d.n || 'Geteilte Instanz');
  fs.mkdirSync(path.join(instDir(id), 'mods'), { recursive: true });
  const inst = { id, name: String(d.n || 'Geteilte Instanz').slice(0, 80), mc: d.mc, loader: d.l, loaderVersion: d.lv || undefined, mods: [], created: new Date().toISOString(), source: 'shared' };
  if (d.ig) inst.iconGen = d.ig;
  if (typeof d.ii === 'string' && d.ii.length < 20000 && /^[A-Za-z0-9+/=]+$/.test(d.ii)) inst.icon = 'data:image/jpeg;base64,' + d.ii;
  if (typeof d.ic === 'string' && /^https:\/\/cdn\.modrinth\.com\/[^"'\s]+$/.test(d.ic)) inst.icon = d.ic;
  const want = [...(d.m || []).map((v) => [v, 'mod']), ...(d.r || []).map((v) => [v, 'resourcepack']), ...(d.s || []).map((v) => [v, 'shader'])];
  const kindOfV = new Map(want);
  const versions = [];
  for (let i = 0; i < want.length; i += 100) {
    try { versions.push(...await getJson(`${MR}/versions?ids=${encodeURIComponent(JSON.stringify(want.slice(i, i + 100).map((x) => x[0])))}`)); } catch {}
  }
  const projs = {};
  const pids = [...new Set(versions.map((v) => v.project_id))];
  for (let i = 0; i < pids.length; i += 100) { try { for (const p of await getJson(`${MR}/projects?ids=${encodeURIComponent(JSON.stringify(pids.slice(i, i + 100)))}`)) projs[p.id] = p; } catch {} }
  const failed = []; let n = 0;
  await pool(versions, conc(), async (v) => {
    const kind = kindOfV.get(v.id) || 'mod';
    const f = v.files.find((x) => x.primary) || v.files[0];
    try {
      if (!kindOfV.has(v.id)) throw new Error('Unerwartete Modrinth-Version.');
      await downloadModrinth(f, path.join(instDir(id), KIND_DIR[kind], modFile(f.filename)));
      const p = projs[v.project_id] || {};
      inst.mods.push({ file: f.filename, projectId: v.project_id, versionId: v.id, version: v.version_number, title: p.title || f.filename, icon: p.icon_url || undefined, kind });
    } catch (e) { failed.push((projs[v.project_id] || {}).title || f.filename); }
    status(`Lade geteilte Instanz ${++n}/${versions.length} ...`);
  });
  const missing = want.length - versions.length;
  saveNewInst(inst);
  status(`Import fertig: ${inst.mods.length} Dateien` + (failed.length || missing ? `, ${failed.length + missing} nicht gefunden` : ''));
  return inst;
});

// Export als .mrpack (Modrinth-Format): Modrinth-Dateien als Download-Links, Rest als Overrides
ipcMain.handle('share:exportMrpack', async ({ id, includeConfig }) => {
  const inst = readInst(id);
  const res = await dialog.showSaveDialog(win, { title: 'Modpack exportieren', defaultPath: path.join(app.getPath('downloads'), safeName(inst.name) + '.mrpack'), filters: [{ name: 'Modrinth-Modpack', extensions: ['mrpack'] }] });
  if (res.canceled || !res.filePath) return null;
  status('Erstelle Modpack ...');
  const active = inst.mods.filter((m) => !m.disabled);
  const vids = active.filter((m) => m.versionId).map((m) => m.versionId);
  const vmap = {};
  for (let i = 0; i < vids.length; i += 100) { try { for (const v of await getJson(`${MR}/versions?ids=${encodeURIComponent(JSON.stringify(vids.slice(i, i + 100)))}`)) vmap[v.id] = v; } catch {} }
  const files = [], zipFiles = [];
  for (const m of active) {
    const v = m.versionId && vmap[m.versionId];
    const f = v && (v.files.find((x) => x.filename === m.file) || v.files.find((x) => x.primary) || v.files[0]);
    const rel = KIND_DIR[kindOf(m)] + '/' + m.file;
    if (f && f.hashes && f.hashes.sha512) {
      files.push({ path: rel, hashes: { sha1: f.hashes.sha1, sha512: f.hashes.sha512 }, env: { client: 'required', server: kindOf(m) === 'mod' ? 'required' : 'unsupported' }, downloads: [f.url], fileSize: f.size });
    } else {
      try { zipFiles.push({ name: 'overrides/' + rel, data: fs.readFileSync(entryPath(id, m)) }); } catch {}
    }
  }
  if (includeConfig) {
    const add = (dirRel) => {
      const abs = path.join(instDir(id), dirRel);
      if (!fs.existsSync(abs)) return;
      for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
        const r = dirRel + '/' + e.name;
        if (e.isDirectory()) add(r); else { try { zipFiles.push({ name: 'overrides/' + r, data: fs.readFileSync(path.join(abs, e.name)) }); } catch {} }
      }
    };
    add('config');
    if (fs.existsSync(path.join(instDir(id), 'options.txt'))) zipFiles.push({ name: 'overrides/options.txt', data: fs.readFileSync(path.join(instDir(id), 'options.txt')) });
  }
  const lv = await resolveLoaderVersion(inst);
  const depKey = { fabric: 'fabric-loader', quilt: 'quilt-loader', forge: 'forge', neoforge: 'neoforge' }[inst.loader];
  const index = { formatVersion: 1, game: 'minecraft', versionId: '1.0.0', name: inst.name, summary: 'Exportiert aus Modstack', files, dependencies: { minecraft: inst.mc, ...(lv ? { [depKey]: lv } : {}) } };
  zipFiles.unshift({ name: 'modrinth.index.json', data: Buffer.from(JSON.stringify(index, null, 2)) });
  if (inst.icon || inst.iconGen) zipFiles.push({ name: 'modstack.json', data: Buffer.from(JSON.stringify({ icon: inst.icon, iconGen: inst.iconGen })) });
  fs.writeFileSync(res.filePath, writeZip(zipFiles));
  status('Modpack gespeichert: ' + path.basename(res.filePath));
  shell.showItemInFolder(res.filePath);
  return { path: res.filePath, linked: files.length, embedded: zipFiles.length - 1 };
});

// ---------- Minecraft-Vorbereitung ----------
const gamePreparation = require('./minecraft-preparation')({
  directory: mcDir,
  enabled: () => appSettings().prepareMinecraft !== false && process.env.MODSTACK_UPDATE_VERIFY_ONLY !== '1',
  loader: (inst) => ensureLoader(inst, () => {}, AbortSignal.timeout(12000)),
  notify: (info) => {
    if (win && !win.isDestroyed()) win.webContents.send('minecraftPreparation', info);
  },
  concurrency: conc,
  userAgent: UA,
});
ipcMain.handle('mc:prepare', ({ id, retry }) => gamePreparation.schedule(readInst(id), retry === true));

// ---------- Java ----------
// Welche Java-Hauptversion braucht eine Minecraft-Version?
function javaMajorFor(mc) {
  const p = String(mc || '').split('.').map((x) => parseInt(x, 10) || 0);
  if (p[0] !== 1) return 25; // neue Versionsnummern ab 26.x
  if (p[1] <= 16) return 8;
  if (p[1] <= 19) return 17;
  if (p[1] === 20) return p[2] >= 5 ? 21 : 17;
  return 21;
}
const JAVA_COMPONENT = { 8: ['jre-legacy'], 17: ['java-runtime-gamma', 'java-runtime-beta'], 21: ['java-runtime-delta'], 25: ['java-runtime-epsilon'] };
const javaRoot = () => path.join(app.getPath('userData'), 'java');

function javaVersionOf(exe) {
  return new Promise((resolve) => {
    execFile(exe, ['-version'], { windowsHide: true, timeout: 10000 }, (err, so, se) => {
      if (err) return resolve(0);
      const m = /version "(\d+)(?:\.(\d+))?/.exec(String(se) + String(so));
      if (!m) return resolve(0);
      resolve(m[1] === '1' ? parseInt(m[2], 10) : parseInt(m[1], 10));
    });
  });
}

// Sucht vorhandenes Java: eigene Downloads, Mojang-Launcher-Runtimes, JAVA_HOME, PATH
async function findJava(major) {
  const own = path.join(javaRoot(), String(major));
  if (fs.existsSync(own)) {
    for (const d of fs.readdirSync(own)) { const p = path.join(own, d, 'bin', 'java.exe'); if (fs.existsSync(p)) return p; }
  }
  const bases = [
    path.join(mcDir(), 'runtime'),
    path.join(process.env.LOCALAPPDATA || '', 'Packages', 'Microsoft.4297127D64EC6_8wekyb3d8bbwe', 'LocalCache', 'Local', 'runtime'),
    'C:\\Program Files (x86)\\Minecraft Launcher\\runtime',
    'C:\\XboxGames\\Minecraft Launcher\\Content\\runtime',
  ];
  for (const b of bases) {
    for (const comp of JAVA_COMPONENT[major] || []) {
      const p = path.join(b, comp, 'windows-x64', comp, 'bin', 'java.exe');
      if (fs.existsSync(p)) return p;
    }
  }
  const cands = [];
  if (process.env.JAVA_HOME) cands.push(path.join(process.env.JAVA_HOME, 'bin', 'java.exe'));
  cands.push('java');
  for (const c of cands) { if ((await javaVersionOf(c)) === major) return c; }
  return null;
}

// Laedt eine portable Java-Laufzeit (Eclipse Temurin, offizielle Adoptium-Quelle) in den Datenordner
async function downloadJava(major) {
  status(`Java ${major} wird heruntergeladen (einmalig) ...`);
  const meta = await getJson(`https://api.adoptium.net/v3/assets/latest/${major}/hotspot?architecture=x64&image_type=jre&os=windows&vendor=eclipse`);
  const pkg = meta && meta[0] && meta[0].binary && meta[0].binary.package;
  if (!pkg || !/^https:\/\/github\.com\/adoptium\//.test(pkg.link)) throw new Error('Keine passende Java-Version gefunden');
  const r = await fetch(pkg.link, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error('Java-Download fehlgeschlagen (' + r.status + ')');
  const total = pkg.size || +r.headers.get('content-length') || 0;
  const chunks = []; let got = 0, lastPct = -1;
  const reader = r.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value)); got += value.length;
    const pct = total ? Math.floor(got / total * 100) : 0;
    if (pct !== lastPct) { lastPct = pct; status(`Java ${major} wird heruntergeladen ${pct}/100 ...`); }
  }
  const buf = Buffer.concat(chunks);
  if (pkg.checksum && crypto.createHash('sha256').update(buf).digest('hex') !== pkg.checksum) throw new Error('Java-Download beschaedigt (Pruefsumme)');
  status(`Java ${major} wird entpackt ...`);
  const dest = path.resolve(javaRoot(), String(major));
  fs.rmSync(dest, { recursive: true, force: true });
  for (const e of readZip(buf)) {
    if (e.dir) continue;
    const out = path.resolve(dest, e.name);
    if (!out.startsWith(dest + path.sep)) continue;
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, e.data());
  }
  const exe = await findJava(major);
  if (!exe) throw new Error('Java wurde entpackt, aber nicht gefunden');
  status(`Java ${major} bereit`);
  return exe;
}

async function ensureJava(major) {
  return (await findJava(major)) || downloadJava(major);
}

ipcMain.handle('java:status', async (mc) => {
  const major = javaMajorFor(mc);
  const p = await findJava(major);
  return { major, path: p, own: !!(p && p.startsWith(javaRoot())) };
});

ipcMain.handle('java:ensure', async (mc) => {
  const exe = await ensureJava(javaMajorFor(mc));
  return { path: exe, version: await javaVersionOf(exe) };
});

async function runInstaller(jar, mc) {
  const java = await ensureJava(javaMajorFor(mc));
  return new Promise((resolve, reject) => {
    const p = spawn(java, ['-jar', jar, '--installClient', mcDir()], { windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('error', (e) => reject(new Error('Java konnte nicht gestartet werden: ' + e.message)));
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error('Loader-Installer fehlgeschlagen:\n' + out.slice(-600)))));
  });
}

function ensureLauncherProfilesFile() {
  fs.mkdirSync(mcDir(), { recursive: true });
  const f = path.join(mcDir(), 'launcher_profiles.json');
  if (!fs.existsSync(f)) fs.writeFileSync(f, JSON.stringify({ profiles: {}, settings: {}, version: 3 }));
  return f;
}

async function ensureLoader(inst, report = status, signal) {
  const vdir = (id) => path.join(mcDir(), 'versions', id);
  if (inst.loader === 'fabric' || inst.loader === 'quilt') {
    const base = inst.loader === 'fabric' ? 'https://meta.fabricmc.net/v2/versions/loader' : 'https://meta.quiltmc.org/v3/versions/loader';
    const list = await getJson(`${base}/${inst.mc}`, signal);
    if (!list.length) throw new Error('Kein ' + inst.loader + '-Loader fuer ' + inst.mc);
    const pick = (inst.loaderVersion && list.find((x) => x.loader && x.loader.version === inst.loaderVersion))
      || list.find((x) => x.loader && x.loader.stable !== false && !/beta|pre|rc/i.test(x.loader.version)) || list[0];
    const lv = pick.loader.version;
    const prof = await getJson(`${base}/${inst.mc}/${lv}/profile/json`, signal);
    if (typeof prof.id !== 'string' || !/^[A-Za-z0-9][\w.+-]*$/.test(prof.id)) throw new Error('Ungültiges Loader-Profil.');
    const dir = vdir(prof.id);
    const profileFile = path.join(dir, prof.id + '.json');
    if (!fs.existsSync(profileFile)) {
      report('Installiere ' + inst.loader + ' ' + lv + ' ...');
      fs.mkdirSync(dir, { recursive: true });
      const temp = profileFile + '.' + crypto.randomUUID() + '.part';
      try {
        fs.writeFileSync(temp, JSON.stringify(prof, null, 2), { flag: 'wx' });
        fs.renameSync(temp, profileFile);
      } finally { fs.rmSync(temp, { force: true }); }
    }
    return prof.id;
  }
  if (inst.loader === 'forge') {
    const promos = (await getJson('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json')).promos;
    const v = (inst.loaderVersion && /^[\d.]+$/.test(inst.loaderVersion) ? inst.loaderVersion : null)
      || promos[inst.mc + '-recommended'] || promos[inst.mc + '-latest'];
    if (!v) throw new Error('Kein Forge fuer ' + inst.mc);
    const vid = `${inst.mc}-forge-${v}`;
    if (!fs.existsSync(path.join(vdir(vid), vid + '.json'))) {
      status('Installiere Forge ' + v + ' (kann dauern) ...');
      ensureLauncherProfilesFile();
      const jar = path.join(app.getPath('temp'), `forge-${inst.mc}-${v}-installer.jar`);
      await download(`https://maven.minecraftforge.net/net/minecraftforge/forge/${inst.mc}-${v}/forge-${inst.mc}-${v}-installer.jar`, jar);
      await runInstaller(jar, inst.mc);
      if (!fs.existsSync(path.join(vdir(vid), vid + '.json'))) throw new Error('Forge-Version nach Installation nicht gefunden (' + vid + ')');
    }
    return vid;
  }
  if (inst.loader === 'neoforge') {
    const parts = inst.mc.split('.'); // 1.21.1 -> 21.1.
    // alt: 1.21.1 -> "21.1." ; neu (ab 26.x ohne "1."): 26.3 -> "26.3."
    const prefix = parts[0] === '1' ? `${parts[1]}.${parts[2] || '0'}.` : `${parts[0]}.${parts[1] || '0'}.`;
    const all = (await getJson('https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge')).versions || [];
    const cands = all.filter((x) => x.startsWith(prefix));
    if (!cands.length) throw new Error('Kein NeoForge fuer ' + inst.mc);
    const stable = cands.filter((x) => !/beta|alpha/i.test(x));
    const v = (inst.loaderVersion && cands.includes(inst.loaderVersion)) ? inst.loaderVersion : (stable.length ? stable : cands).slice(-1)[0];
    const vid = 'neoforge-' + v;
    if (!fs.existsSync(path.join(vdir(vid), vid + '.json'))) {
      status('Installiere NeoForge ' + v + ' (kann dauern) ...');
      ensureLauncherProfilesFile();
      const jar = path.join(app.getPath('temp'), `neoforge-${v}-installer.jar`);
      await download(`https://maven.neoforged.net/releases/net/neoforged/neoforge/${v}/neoforge-${v}-installer.jar`, jar);
      await runInstaller(jar, inst.mc);
      if (!fs.existsSync(path.join(vdir(vid), vid + '.json'))) throw new Error('NeoForge-Version nach Installation nicht gefunden (' + vid + ')');
    }
    return vid;
  }
  throw new Error('Unbekannter Loader');
}

// ---------- Spielen ----------
function launcherRunning() {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', 'IMAGENAME eq MinecraftLauncher.exe', '/NH'], (err, out) => {
      resolve(!err && /MinecraftLauncher\.exe/i.test(out));
    });
  });
}

ipcMain.handle('play', (id) => instanceWork(id, async () => {
  const initial = readInst(id);
  if (await launcherRunning()) {
    throw new Error('Der Mojang-Launcher laeuft noch. Bitte schliessen, sonst ueberschreibt er das Profil.');
  }
  await backups.daily(id);
  const preparedLoader = await gamePreparation.beforePlay(initial);
  await gamePreparation.vanilla(initial.mc);
  const versionId = preparedLoader || await ensureLoader(initial);
  if (await launcherRunning()) {
    throw new Error('Der Mojang-Launcher wurde während der Vorbereitung geöffnet. Bitte schließe ihn und klicke erneut auf Spielen.');
  }
  const inst = readInst(id);

  const f = ensureLauncherProfilesFile();
  let data;
  try { data = readJson(f); } catch { data = { profiles: {}, settings: {}, version: 3 }; }
  data.profiles = data.profiles || {};
  const key = 'modmanager-' + inst.id;
  const now = new Date().toISOString();
  data.profiles[key] = {
    ...(data.profiles[key] || {}),
    created: (data.profiles[key] && data.profiles[key].created) || now,
    icon: 'Crafting_Table',
    lastUsed: new Date(Date.now() + 1000).toISOString(),
    lastVersionId: versionId,
    name: '[Modstack] ' + inst.name,
    type: 'custom',
    gameDir: instDir(inst.id),
  };
  const jargs = [inst.ram ? `-Xmx${inst.ram}M` : '', inst.javaArgs || ''].join(' ').trim();
  if (jargs) data.profiles[key].javaArgs = jargs;
  else delete data.profiles[key].javaArgs;
  if (inst.resolution) data.profiles[key].resolution = { width: inst.resolution.width, height: inst.resolution.height };
  else delete data.profiles[key].resolution;
  inst.lastPlayed = new Date().toISOString(); saveInst(inst);
  fs.writeFileSync(f, JSON.stringify(data, null, 2));

  const candidates = [
    'C:\\Program Files (x86)\\Minecraft Launcher\\MinecraftLauncher.exe',
    'C:\\Program Files\\Minecraft Launcher\\MinecraftLauncher.exe',
  ];
  const exe = candidates.find((p) => fs.existsSync(p));
  if (exe) spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
  else spawn('explorer.exe', ['shell:AppsFolder\\Microsoft.4297127D64EC6_8wekyb3d8bbwe!Minecraft'], { detached: true, stdio: 'ignore' }).unref();
  if (appSettings().minimizeOnPlay && win) win.minimize();
  status('Launcher gestartet. Waehle dort das Profil "[Modstack] ' + inst.name + '" und klicke Spielen.');
  return true;
}));

// ---------- App / Fenster-Aktionen ----------
ipcMain.handle('instances:rename', ({ id, name }) => {
  const inst = readInst(id);
  const n = String(name || '').trim();
  if (!n) throw new Error('Name darf nicht leer sein');
  inst.name = n.slice(0, 80);
  saveInst(inst);
  return inst;
});
ipcMain.handle('app:openRoot', () => { fs.mkdirSync(instRoot(), { recursive: true }); shell.openPath(instRoot()); return true; });
ipcMain.handle('app:showMod', ({ id, file }) => {
  const m = readInst(id).mods.find((x) => x.file === file);
  shell.showItemInFolder(m ? entryPath(id, m) : path.join(instDir(id), 'mods', path.basename(file)));
  return true;
});
ipcMain.handle('app:openUrl', (url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return true; });
ipcMain.handle('app:quit', () => { win?.close(); return true; });
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('win:devtools', () => { win.webContents.toggleDevTools(); return true; });
ipcMain.handle('win:zoom', (d) => {
  const wc = win.webContents;
  wc.setZoomLevel(d === 0 ? 0 : Math.max(-3, Math.min(3, wc.getZoomLevel() + d)));
  return true;
});
ipcMain.handle('win:overlay', ({ color }) => {
  if (/^#[0-9a-f]{6}$/i.test(color || '') && win.setTitleBarOverlay) win.setTitleBarOverlay({ color, symbolColor: '#c9ced8', height: 36 });
  return true;
});
ipcMain.handle('win:fullscreen', () => { win.setFullScreen(!win.isFullScreen()); return true; });

// ---------- Fenster ----------
function showMainWindow() {
  if (!win || win.isDestroyed()) return;
  hiddenForGame = false;
  tray?.destroy(); tray = undefined;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function hideForPlaytime() {
  if (!tray) {
    const icon = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAx0lEQVR4nO3X3QYCURQF4PNM67EiIiIiIiIiIiIiIspkNBr9KCklpaTUY8wbrO7OTTX6mZkj7cW+3t/FvlhbKYlP4KSJQYZws8QwR4zzxKRATIvErETMy8SiQiyrxKpGrOvEpkFsm8SuRezbxKHDz5b3UwwKgKP1HgJ2kkEDcLJfQ6CXYFgAnB1/BKw4wwbg4j5GoBtjVABcR/cIAQhAAM8Anud9NQL4/RsQgAAEEBlAma5kGmGylGqEyVquESYfE40w+Zr9TW4D7GHVFsS5owAAAABJRU5ErkJggg==');
    tray = new Tray(icon);
    tray.setToolTip('Modstack · Spielzeit wird gemessen');
    tray.on('click', showMainWindow);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Modstack öffnen', click: showMainWindow },
      { label: 'Modstack beenden', click: () => app.quit() },
    ]));
  }
  hiddenForGame = true;
  win.hide();
}

ipcMain.handle('win:closeDecision', (choice) => {
  if (!askingToClose) return;
  askingToClose = false;
  if (choice === 'quit') app.quit();
  else if (choice === 'background') hideForPlaytime();
});

function createWindow() {
  win = new BrowserWindow({
    show: process.env.MODSTACK_UPDATE_VERIFY_ONLY !== '1',
    width: 1180,
    height: 760,
    minWidth: 860,
    minHeight: 560,
    backgroundColor: '#14161b',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#101216', symbolColor: '#c9ced8', height: 36 },
    autoHideMenuBar: true,
    webPreferences: {
      autoplayPolicy: 'no-user-gesture-required',
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.on('close', (event) => {
    if (quitting || appSettings().trackPlaytime === false || process.env.MODSTACK_UPDATE_VERIFY_ONLY === '1') return;
    event.preventDefault();
    if (askingToClose) return;
    askingToClose = true;
    playtime.sample().catch(() => []).then((active) => {
      if (quitting || !win || win.isDestroyed()) return;
      if (!active.length) { askingToClose = false; app.quit(); }
      else win.webContents.send('playtimeClose');
    });
  });
  win.loadFile('index.html');
}

Menu.setApplicationMenu(null); // eigenes Menue im Fenster
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => tray?.destroy());
if (hasAppLock) {
  if (process.platform === 'win32') app.setAppUserModelId('com.modstack.app');
  app.whenReady().then(createWindow);
  app.on('second-instance', showMainWindow);
  if (process.env.MODSTACK_UPDATE_VERIFY_ONLY !== '1') setInterval(() => {
    if (hiddenForGame || appSettings().trackPlaytime !== false) playtime.sample().catch(() => {});
  }, 9000).unref();
} else app.quit();
app.on('window-all-closed', () => app.quit());
