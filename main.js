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

ipcMain.handle('instances:settings', ({ id, ram, javaArgs }) => {
  const inst = readInst(id);
  inst.ram = ram ? Math.max(1024, Math.min(65536, parseInt(ram, 10) || 0)) : undefined;
  inst.javaArgs = String(javaArgs || '').replace(/-Xm[xs]\S*/g, '').trim() || undefined;
  saveInst(inst);
  return inst;
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
