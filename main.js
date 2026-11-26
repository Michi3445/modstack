const { app, BrowserWindow, ipcMain: rawIpc, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const zlib = require('zlib');
const { execFile, spawn } = require('child_process');

// ipcMain.handle ruft (event, daten) auf; die Handler unten erwarten nur die Daten.
const ipcMain = { handle: (ch, fn) => rawIpc.handle(ch, (_e, data) => fn(data)) };

const UA = 'Modstack/1.1 (persoenliches Projekt)';
const MR = 'https://api.modrinth.com/v2';
const LOADERS = ['fabric', 'forge', 'neoforge', 'quilt'];

let win;
// Datenordner vom alten Namen behalten, damit vorhandene Instanzen bleiben
app.setPath('userData', path.join(app.getPath('appData'), 'modmanager'));
const instRoot = () => path.join(app.getPath('userData'), 'instances');
const mcDir = () => path.join(process.env.APPDATA || '', '.minecraft');

function status(msg) {
  if (win && !win.isDestroyed()) win.webContents.send('status', msg);
}

// ---------- Hilfsfunktionen ----------
async function getJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
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
  return JSON.parse(fs.readFileSync(path.join(instDir(id), 'instance.json'), 'utf8'));
}

function saveInst(inst) {
  fs.writeFileSync(path.join(instDir(inst.id), 'instance.json'), JSON.stringify(inst, null, 2));
}

// ---------- Instanzen ----------
ipcMain.handle('instances:list', () => {
  fs.mkdirSync(instRoot(), { recursive: true });
  const out = [];
  for (const d of fs.readdirSync(instRoot())) {
    const f = path.join(instRoot(), d, 'instance.json');
    if (fs.existsSync(f)) {
      try { out.push(JSON.parse(fs.readFileSync(f, 'utf8'))); } catch {}
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
  const inst = { id, name, mc, loader, mods: [] };
  saveInst(inst);
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
ipcMain.handle('mr:search', async ({ query, mc, loader, offset }) => {
  const facets = [['project_type:mod'], [`versions:${mc}`]];
  facets.push(loader === 'quilt' ? ['categories:quilt', 'categories:fabric'] : [`categories:${loader}`]);
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
  }));
});

function loaderList(inst) {
  return inst.loader === 'quilt' ? ['quilt', 'fabric'] : [inst.loader];
}

async function latestVersion(inst, projectId) {
  const url = `${MR}/project/${projectId}/version?loaders=${encodeURIComponent(JSON.stringify(loaderList(inst)))}&game_versions=${encodeURIComponent(JSON.stringify([inst.mc]))}`;
  const vs = await getJson(url);
  return vs[0] || null; // neueste zuerst
}

async function installProject(inst, projectId, isDep) {
  if (inst.mods.some((m) => m.projectId === projectId)) return;
  const v = await latestVersion(inst, projectId);
  if (!v) {
    if (isDep) { status(`Abhaengigkeit ${projectId}: keine passende Version, uebersprungen`); return; }
    throw new Error('Keine passende Version fuer ' + inst.mc + ' / ' + inst.loader);
  }
  const f = v.files.find((x) => x.primary) || v.files[0];
  const proj = await getJson(`${MR}/project/${projectId}`);
  status('Lade ' + proj.title + ' ...');
  await download(f.url, path.join(instDir(inst.id), 'mods', f.filename), f.hashes && f.hashes.sha1);
  inst.mods.push({ file: f.filename, projectId, versionId: v.id, title: proj.title });
  saveInst(inst);
  for (const d of v.dependencies || []) {
    if (d.dependency_type === 'required' && d.project_id) await installProject(inst, d.project_id, true);
  }
}

ipcMain.handle('mr:install', async ({ id, projectId }) => {
  const inst = readInst(id);
  await installProject(inst, projectId, false);
  status('Fertig');
  return readInst(id);
});

ipcMain.handle('mr:checkUpdates', async (id) => {
  const inst = readInst(id);
  const res = [];
  for (const m of inst.mods) {
    if (!m.projectId) continue;
    try {
      const v = await latestVersion(inst, m.projectId);
      if (v && v.id !== m.versionId) res.push(m.projectId);
    } catch {}
  }
  return res;
});

ipcMain.handle('mr:updateAll', async (id) => {
  const inst = readInst(id);
  let count = 0;
  for (const m of inst.mods) {
    if (!m.projectId) continue;
    const v = await latestVersion(inst, m.projectId);
    if (!v || v.id === m.versionId) continue;
    const f = v.files.find((x) => x.primary) || v.files[0];
    status('Aktualisiere ' + m.title + ' ...');
    await download(f.url, path.join(instDir(id), 'mods', f.filename), f.hashes && f.hashes.sha1);
    if (f.filename !== m.file) fs.rmSync(path.join(instDir(id), 'mods', m.file), { force: true });
    m.file = f.filename;
    m.versionId = v.id;
    count++;
  }
  saveInst(inst);
  status(count + ' Mods aktualisiert');
  return readInst(id);
});

ipcMain.handle('mods:remove', ({ id, file }) => {
  const inst = readInst(id);
  fs.rmSync(path.join(instDir(id), 'mods', path.basename(file)), { force: true });
  inst.mods = inst.mods.filter((m) => m.file !== file);
  saveInst(inst);
  return inst;
});

ipcMain.handle('mods:addFiles', ({ id, paths }) => {
  const inst = readInst(id);
  for (const p of paths) {
    if (!p.toLowerCase().endsWith('.jar')) continue;
    const name = path.basename(p);
    fs.copyFileSync(p, path.join(instDir(id), 'mods', name));
    if (!inst.mods.some((m) => m.file === name)) inst.mods.push({ file: name, title: name, manual: true });
  }
  saveInst(inst);
  return inst;
});

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
      data: () => {
        const start = loc + 30 + buf.readUInt16LE(loc + 26) + buf.readUInt16LE(loc + 28);
        const raw = buf.slice(start, start + csize);
        if (method === 0) return raw;
        if (method === 8) return zlib.inflateRawSync(raw);
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

async function importProfileZip(buf, fallbackName) {
  const entries = readZip(buf);
  const me = entries.find((e) => e.name === 'manifest.json');
  if (!me) throw new Error('Keine manifest.json im Profil. Ist das ein CurseForge-Profil-Export?');
  const man = JSON.parse(me.data().toString('utf8').replace(/^﻿/, ''));
  const mc = man.minecraft && man.minecraft.version;
  if (!mc) throw new Error('Profil enthaelt keine Minecraft-Version');
  const ml = (man.minecraft.modLoaders || []).find((x) => x.primary) || (man.minecraft.modLoaders || [])[0];
  const pl = ml && parseLoader(ml.id);
  if (!pl) throw new Error('Unbekannter Mod-Loader im Profil: ' + (ml ? ml.id : 'keiner'));

  const name = man.name || fallbackName || 'CurseForge-Profil';
  let id = safeName(name);
  let n = 1;
  while (fs.existsSync(instDir(id))) id = safeName(name) + '_' + ++n;
  const dir = instDir(id);
  fs.mkdirSync(path.join(dir, 'mods'), { recursive: true });
  const inst = { id, name, mc, loader: pl.loader, loaderVersion: pl.version, mods: [], source: 'curseforge' };
  saveInst(inst);

  // Overrides (Configs, manuell eingefuegte Mods usw.)
  const ov = (man.overrides || 'overrides').replace(/\/+$/, '') + '/';
  for (const e of entries) {
    if (e.dir || !e.name.startsWith(ov)) continue;
    const rel = e.name.slice(ov.length);
    const dest = path.resolve(dir, rel);
    if (!rel || !dest.startsWith(path.resolve(dir) + path.sep)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, e.data());
    if (/^mods\/[^/]+\.jar$/i.test(rel)) inst.mods.push({ file: path.basename(rel), title: path.basename(rel), manual: true });
  }

  const files = man.files || [];
  const failed = [];
  let done = 0;
  await pool(files, 6, async (f) => {
    try {
      const info = (await getJson(`${CFW}/${f.projectID}/files/${f.fileID}`)).data;
      const data = await fetchBuf(`${CFW}/${f.projectID}/files/${f.fileID}/download`);
      if (info.fileLength && data.length !== info.fileLength) throw new Error('Dateigroesse stimmt nicht');
      const folder = targetFolder(info.fileName, data);
      fs.mkdirSync(path.join(dir, folder), { recursive: true });
      fs.writeFileSync(path.join(dir, folder, path.basename(info.fileName)), data);
      if (folder === 'mods') {
        inst.mods.push({ file: path.basename(info.fileName), title: cfTitle(info), cf: { projectId: f.projectID, fileId: f.fileID } });
      }
    } catch (e) {
      failed.push(`Projekt ${f.projectID} / Datei ${f.fileID}: ${e.message}`);
    }
    done++;
    status(`Lade CurseForge-Dateien ${done}/${files.length} ...`);
  });
  saveInst(inst);
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
  const res = await dialog.showOpenDialog(win, { title: 'CurseForge-Profil (.zip) waehlen', filters: [{ name: 'ZIP', extensions: ['zip'] }], properties: ['openFile'] });
  if (res.canceled || !res.filePaths.length) return null;
  const p = res.filePaths[0];
  status('Lese ' + path.basename(p) + ' ...');
  return importProfileZip(fs.readFileSync(p), path.basename(p, '.zip'));
});

// ---------- Loader-Installation ----------
async function ensureVanilla(mc) {
  const dir = path.join(mcDir(), 'versions', mc);
  const jf = path.join(dir, mc + '.json');
  if (fs.existsSync(jf)) return;
  status('Lade Vanilla-Versionsdaten ...');
  const man = await getJson('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
  const e = man.versions.find((v) => v.id === mc);
  if (!e) throw new Error('Minecraft-Version unbekannt: ' + mc);
  fs.mkdirSync(dir, { recursive: true });
  await download(e.url, jf);
}

function findJava() {
  const bases = [
    path.join(mcDir(), 'runtime'),
    path.join(process.env.LOCALAPPDATA || '', 'Packages', 'Microsoft.4297127D64EC6_8wekyb3d8bbwe', 'LocalCache', 'Local', 'runtime'),
  ];
  const found = [];
  for (const b of bases) {
    if (!fs.existsSync(b)) continue;
    for (const comp of fs.readdirSync(b)) {
      const p1 = path.join(b, comp, 'windows-x64', comp, 'bin', 'java.exe');
      if (fs.existsSync(p1)) found.push({ comp, p: p1 });
    }
  }
  const pref = ['java-runtime-delta', 'java-runtime-gamma', 'java-runtime-beta'];
  for (const c of pref) { const f = found.find((x) => x.comp === c); if (f) return f.p; }
  if (found.length) return found[0].p;
  return 'java'; // PATH-Fallback
}

function runInstaller(jar) {
  return new Promise((resolve, reject) => {
    const java = findJava();
    const p = spawn(java, ['-jar', jar, '--installClient', mcDir()], { windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('error', () => reject(new Error('Java nicht gefunden. Starte den Mojang-Launcher einmal mit einer Minecraft-Version, dann gibt es eine Java-Runtime.')));
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error('Loader-Installer fehlgeschlagen:\n' + out.slice(-600)))));
  });
}

function ensureLauncherProfilesFile() {
  fs.mkdirSync(mcDir(), { recursive: true });
  const f = path.join(mcDir(), 'launcher_profiles.json');
  if (!fs.existsSync(f)) fs.writeFileSync(f, JSON.stringify({ profiles: {}, settings: {}, version: 3 }));
  return f;
}

async function ensureLoader(inst) {
  const vdir = (id) => path.join(mcDir(), 'versions', id);
  if (inst.loader === 'fabric' || inst.loader === 'quilt') {
    const base = inst.loader === 'fabric' ? 'https://meta.fabricmc.net/v2/versions/loader' : 'https://meta.quiltmc.org/v3/versions/loader';
    const list = await getJson(`${base}/${inst.mc}`);
    if (!list.length) throw new Error('Kein ' + inst.loader + '-Loader fuer ' + inst.mc);
    const pick = (inst.loaderVersion && list.find((x) => x.loader && x.loader.version === inst.loaderVersion))
      || list.find((x) => x.loader && x.loader.stable !== false && !/beta|pre|rc/i.test(x.loader.version)) || list[0];
    const lv = pick.loader.version;
    const prof = await getJson(`${base}/${inst.mc}/${lv}/profile/json`);
    const dir = vdir(prof.id);
    if (!fs.existsSync(path.join(dir, prof.id + '.json'))) {
      status('Installiere ' + inst.loader + ' ' + lv + ' ...');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, prof.id + '.json'), JSON.stringify(prof, null, 2));
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
      await runInstaller(jar);
      if (!fs.existsSync(path.join(vdir(vid), vid + '.json'))) throw new Error('Forge-Version nach Installation nicht gefunden (' + vid + ')');
    }
    return vid;
  }
  if (inst.loader === 'neoforge') {
    const parts = inst.mc.split('.'); // 1.21.1 -> 21.1.
    const prefix = `${parts[1]}.${parts[2] || '0'}.`;
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
      await runInstaller(jar);
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

ipcMain.handle('play', async (id) => {
  const inst = readInst(id);
  if (await launcherRunning()) {
    throw new Error('Der Mojang-Launcher laeuft noch. Bitte schliessen, sonst ueberschreibt er das Profil.');
  }
  await ensureVanilla(inst.mc);
  const versionId = await ensureLoader(inst);

  const f = ensureLauncherProfilesFile();
  let data;
  try { data = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { data = { profiles: {}, settings: {}, version: 3 }; }
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
  fs.writeFileSync(f, JSON.stringify(data, null, 2));

  const candidates = [
    'C:\\Program Files (x86)\\Minecraft Launcher\\MinecraftLauncher.exe',
    'C:\\Program Files\\Minecraft Launcher\\MinecraftLauncher.exe',
  ];
  const exe = candidates.find((p) => fs.existsSync(p));
  if (exe) spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
  else spawn('explorer.exe', ['shell:AppsFolder\\Microsoft.4297127D64EC6_8wekyb3d8bbwe!Minecraft'], { detached: true, stdio: 'ignore' }).unref();
  status('Launcher gestartet. Waehle dort das Profil "[Modstack] ' + inst.name + '" und klicke Spielen.');
  return true;
});

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
ipcMain.handle('app:showMod', ({ id, file }) => { shell.showItemInFolder(path.join(instDir(id), 'mods', path.basename(file))); return true; });
ipcMain.handle('app:openUrl', (url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return true; });
ipcMain.handle('app:quit', () => { app.quit(); return true; });
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('win:devtools', () => { win.webContents.toggleDevTools(); return true; });
ipcMain.handle('win:zoom', (d) => {
  const wc = win.webContents;
  wc.setZoomLevel(d === 0 ? 0 : Math.max(-3, Math.min(3, wc.getZoomLevel() + d)));
  return true;
});
ipcMain.handle('win:fullscreen', () => { win.setFullScreen(!win.isFullScreen()); return true; });

// ---------- Fenster ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 860,
    minHeight: 560,
    backgroundColor: '#14161b',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#101216', symbolColor: '#c9ced8', height: 36 },
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile('index.html');
}

const { Menu } = require('electron');
Menu.setApplicationMenu(null); // eigenes Menue im Fenster
app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
