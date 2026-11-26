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
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
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
  return readJson(path.join(instDir(id), 'instance.json'));
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
      try { out.push(readJson(f)); } catch {}
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
const KIND_DIR = { mod: 'mods', resourcepack: 'resourcepacks', shader: 'shaderpacks' };
const kindOf = (m) => m.kind || 'mod';
const entryPath = (id, m) => path.join(instDir(id), KIND_DIR[kindOf(m)], m.file + (m.disabled ? '.disabled' : ''));

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
const conc = () => Math.max(1, Math.min(12, appSettings().downloads || 6));

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
  await download(f.url, path.join(instDir(inst.id), KIND_DIR[kind], f.filename), f.hashes && f.hashes.sha1);
  inst.mods.push({ file: f.filename, projectId, versionId: v.id, title: proj.title, icon: proj.icon_url || undefined, kind, version: v.version_number });
  saveInst(inst);
  if (kind === 'mod' && appSettings().autoDeps !== false) {
    for (const d of v.dependencies || []) {
      if (d.dependency_type === 'required' && d.project_id) await installProject(inst, d.project_id, true, 'mod', warnings);
    }
  }
}

ipcMain.handle('mr:install', async ({ id, projectId, kind }) => {
  const inst = readInst(id);
  const warnings = [];
  await installProject(inst, projectId, false, kind, warnings);
  status(warnings.length ? 'Installiert, aber: ' + warnings.join('; ') : 'Fertig');
  return { inst: readInst(id), warnings };
});

// Prueft alle Modrinth-Eintraege einer Instanz; meldet nur echte Updates (neuer als die installierte Version)
async function checkInst(inst, quiet) {
  const list = inst.mods.filter((m) => m.projectId && m.versionId);
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

async function applyUpdate(inst, m, versionId) {
  const v = await getJson(`${MR}/version/${versionId}`);
  const f = v.files.find((x) => x.primary) || v.files[0];
  const old = entryPath(inst.id, m);
  m.file = f.filename; m.versionId = v.id; m.version = v.version_number;
  const neu = entryPath(inst.id, m);
  await download(f.url, neu, f.hashes && f.hashes.sha1);
  if (old !== neu) fs.rmSync(old, { force: true });
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

ipcMain.handle('mr:updateOne', async ({ id, projectId }) => {
  const inst = readInst(id);
  const m = inst.mods.find((x) => x.projectId === projectId);
  if (!m) throw new Error('Mod nicht gefunden');
  const v = await latestVersion(inst, projectId, kindOf(m));
  if (!v || v.id === m.versionId) { status('Schon aktuell'); return inst; }
  status('Aktualisiere ' + m.title + ' ...');
  await applyUpdate(inst, m, v.id);
  saveInst(inst);
  status(m.title + ' aktualisiert auf ' + m.version);
  return readInst(id);
});

ipcMain.handle('mr:updateAll', async (id) => {
  const inst = readInst(id);
  const ups = await checkInst(inst, true);
  let count = 0, n = 0;
  await pool(ups, Math.min(4, conc()), async (u) => {
    status(`Aktualisiere ${++n}/${ups.length} ...`);
    const m = inst.mods.find((x) => x.projectId === u.projectId);
    if (!m) return;
    try { await applyUpdate(inst, m, u.versionId); count++; } catch {}
  });
  saveInst(inst);
  status(count + ' Eintraege aktualisiert');
  return readInst(id);
});

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

ipcMain.handle('mods:remove', ({ id, file }) => {
  const inst = readInst(id);
  const m = inst.mods.find((x) => x.file === file);
  if (m) fs.rmSync(entryPath(id, m), { force: true });
  inst.mods = inst.mods.filter((x) => x.file !== file);
  saveInst(inst);
  return inst;
});

ipcMain.handle('mods:toggle', ({ id, file }) => {
  const inst = readInst(id);
  const m = inst.mods.find((x) => x.file === file);
  if (!m) throw new Error('Eintrag nicht gefunden');
  const from = entryPath(id, m);
  m.disabled = !m.disabled;
  const to = entryPath(id, m);
  if (fs.existsSync(from)) fs.renameSync(from, to);
  saveInst(inst);
  return inst;
});

ipcMain.handle('mods:addFiles', async ({ id, paths }) => {
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
  status(added.length + ' Datei(en) hinzugefuegt');
  return inst;
});

// ---------- Instanz-Extras ----------
ipcMain.handle('instances:duplicate', (id) => {
  const inst = readInst(id);
  const name = inst.name + ' (Kopie)';
  let nid = safeName(name), n = 1;
  while (fs.existsSync(instDir(nid))) nid = safeName(name) + '_' + ++n;
  fs.cpSync(instDir(id), instDir(nid), { recursive: true });
  const copy = { ...inst, id: nid, name };
  saveInst(copy);
  return copy;
});

ipcMain.handle('instances:settings', (p) => {
  const inst = readInst(p.id);
  if ('ram' in p) inst.ram = p.ram ? Math.max(1024, Math.min(65536, parseInt(p.ram, 10) || 0)) : undefined;
  if ('javaArgs' in p) inst.javaArgs = String(p.javaArgs || '').replace(/-Xm[xs]\S*/g, '').trim() || undefined;
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
  return { ticks: worlds.reduce((s, w) => s + w.ticks, 0), worlds, screenshots: count('screenshots', /\.png$/i), bytes: dirSize(dir) };
});

ipcMain.handle('instances:playtimes', () => {
  const out = {};
  try { for (const d of fs.readdirSync(instRoot())) out[d] = worldStats(path.join(instRoot(), d)).reduce((s, w) => s + w.ticks, 0); } catch {}
  return out;
});

ipcMain.handle('instances:info', (id) => {
  const dir = instDir(id);
  const count = (sub, re) => { try { return fs.readdirSync(path.join(dir, sub)).filter((f) => !re || re.test(f)).length; } catch { return 0; } };
  let created = null; try { created = fs.statSync(path.join(dir, 'instance.json')).birthtime; } catch {}
  return { bytes: dirSize(dir), worlds: count('saves'), screenshots: count('screenshots', /\.png$/i), created, path: dir };
});

// ---------- App-Einstellungen, Konto, News ----------
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
ipcMain.handle('settings:get', () => {
  try { return readJson(settingsFile()); } catch { return {}; }
});
ipcMain.handle('settings:set', (patch) => {
  let s = {};
  try { s = readJson(settingsFile()); } catch {}
  Object.assign(s, patch || {});
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
  return s;
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
  const old = bgFile(); if (old) fs.rmSync(old, { force: true });
  const dest = path.join(app.getPath('userData'), 'background' + ext);
  fs.copyFileSync(src, dest);
  return bgData(dest);
});
ipcMain.handle('bg:clear', () => { const p = bgFile(); if (p) fs.rmSync(p, { force: true }); return true; });

// Liest nur Name und UUID des aktiven Kontos aus dem offiziellen Launcher (keine Tokens)
ipcMain.handle('mc:account', () => {
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
});

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
  saveInst(inst);

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
  status('Hole Mod-Infos von Modrinth ...');
  await linkModrinth(inst, linkable);
  saveInst(inst);
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
  saveInst(inst);

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
ipcMain.handle('share:code', (id) => {
  const inst = readInst(id);
  const pick = (k) => inst.mods.filter((m) => m.versionId && kindOf(m) === k && !m.disabled).map((m) => m.versionId);
  const data = { n: inst.name, mc: inst.mc, l: inst.loader, lv: inst.loaderVersion || undefined, m: pick('mod'), r: pick('resourcepack'), s: pick('shader') };
  if (inst.iconGen) data.ig = inst.iconGen;
  if (inst.icon && /^https:\/\/cdn\.modrinth\.com\//.test(inst.icon) && inst.icon.length < 300) data.ic = inst.icon;
  const code = 'MS1-' + zlib.deflateRawSync(Buffer.from(JSON.stringify(data)), { level: 9 }).toString('base64url');
  const skipped = inst.mods.filter((m) => !m.versionId && !m.disabled).map((m) => m.title);
  return { code, included: data.m.length + data.r.length + data.s.length, skipped };
});

ipcMain.handle('share:importCode', async (code) => {
  const m = /^MS1-([A-Za-z0-9_-]+)$/.exec(String(code || '').trim().replace(/\s+/g, ''));
  if (!m) throw new Error('Das ist kein gueltiger Modstack-Code');
  let d; try { d = JSON.parse(zlib.inflateRawSync(Buffer.from(m[1], 'base64url')).toString('utf8')); } catch { throw new Error('Code ist beschaedigt oder unvollstaendig'); }
  if (!d.mc || !LOADERS.includes(d.l)) throw new Error('Code enthaelt keine gueltige Version');
  const id = newInstId(d.n || 'Geteilte Instanz');
  fs.mkdirSync(path.join(instDir(id), 'mods'), { recursive: true });
  const inst = { id, name: String(d.n || 'Geteilte Instanz').slice(0, 80), mc: d.mc, loader: d.l, loaderVersion: d.lv || undefined, mods: [], created: new Date().toISOString(), source: 'shared' };
  if (d.ig) inst.iconGen = d.ig;
  if (typeof d.ic === 'string' && /^https:\/\/cdn\.modrinth\.com\/[^"'\s]+$/.test(d.ic)) inst.icon = d.ic;
  saveInst(inst);
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
      await download(f.url, path.join(instDir(id), KIND_DIR[kind], f.filename), f.hashes && f.hashes.sha1);
      const p = projs[v.project_id] || {};
      inst.mods.push({ file: f.filename, projectId: v.project_id, versionId: v.id, version: v.version_number, title: p.title || f.filename, icon: p.icon_url || undefined, kind });
    } catch (e) { failed.push((projs[v.project_id] || {}).title || f.filename); }
    status(`Lade geteilte Instanz ${++n}/${versions.length} ...`);
  });
  const missing = want.length - versions.length;
  saveInst(inst);
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
  fs.writeFileSync(res.filePath, writeZip(zipFiles));
  status('Modpack gespeichert: ' + path.basename(res.filePath));
  shell.showItemInFolder(res.filePath);
  return { path: res.filePath, linked: files.length, embedded: zipFiles.length - 1 };
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

ipcMain.handle('play', async (id) => {
  const inst = readInst(id);
  if (await launcherRunning()) {
    throw new Error('Der Mojang-Launcher laeuft noch. Bitte schliessen, sonst ueberschreibt er das Profil.');
  }
  await ensureVanilla(inst.mc);
  const versionId = await ensureLoader(inst);

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
ipcMain.handle('app:showMod', ({ id, file }) => {
  const m = readInst(id).mods.find((x) => x.file === file);
  shell.showItemInFolder(m ? entryPath(id, m) : path.join(instDir(id), 'mods', path.basename(file)));
  return true;
});
ipcMain.handle('app:openUrl', (url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return true; });
ipcMain.handle('app:quit', () => { app.quit(); return true; });
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