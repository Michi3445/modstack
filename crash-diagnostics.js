const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const ID = /^[a-z][a-z0-9_.-]{1,63}$/i;
const REPORT = /^crash-[^\\/:*?"<>|]{1,180}\.txt$/i;
const MAX_REPORT = 256 * 1024;

function diagnose(text) {
  const fabric = /(?:Mod\s+)?['"][^\r\n]{1,160}?['"]\s*\(([\w.-]+)\)[^\r\n]*?requires\s+(?:[^\r\n]{0,180}?\s+of\s+)?(?:mod\s+)?['"]?([\w.-]+)['"]?\s*,\s*which is missing/i.exec(text);
  const forge = /(?:Mod ID|modId)\s*:\s*['"]?([\w.-]+)['"]?\s*,\s*(?:Requested by|requestedBy)\s*:\s*['"]?([\w.-]+)['"]?[^\r\n]*(?:MISSING|not installed)/i.exec(text);
  const fromMod = /(?:from mod\s+|Failure message:\s*Mod\s+)([a-z][\w.-]+)/i.exec(text)?.[1];
  const required = /(?:requires|depends on)\s+[^\r\n]{0,130}?(?:\b(?:of|mod)\s+)?['"]?(minecraft|java)['"]?[,\s]+(?:version\s+)?[^\r\n]*/i.exec(text);
  if (/UnsupportedClassVersionError|class file version.+(?:only recognizes|supports)|requires Java (?:version )?\d+|requires[^\r\n]{0,150}of java\b/i.test(text) || required?.[1]?.toLowerCase() === 'java') {
    return { type: 'java', message: 'Ein Mod oder Loader braucht eine andere Java-Version.', modId: fabric?.[1] || fromMod };
  }
  if (/requires[^\r\n]{0,150}(?:of minecraft\b|Minecraft version)|wrong Minecraft version/i.test(text) || required?.[1]?.toLowerCase() === 'minecraft') {
    return { type: 'minecraft', message: 'Ein Mod ist für eine andere Minecraft-Version gebaut.', modId: fabric?.[1] || fromMod };
  }
  if (fabric || forge || /Missing or unsupported mandatory dependencies|requires[^\r\n]{1,220}which is missing/i.test(text)) {
    return { type: 'dependency', message: 'Eine erforderliche Mod-Abhängigkeit fehlt oder hat die falsche Version.',
      modId: fabric?.[1] || forge?.[2] || fromMod, dependency: fabric?.[2] || forge?.[1] };
  }
  if (/OutOfMemoryError|Java heap space|GC overhead limit exceeded|Could not reserve enough space for (?:object heap|[\d]+KB)/i.test(text)) {
    return { type: 'memory', message: 'Minecraft hatte beim Laden zu wenig Java-Arbeitsspeicher.', modId: fromMod };
  }
  if (/DuplicateModsFoundException|duplicate mod(?:s| ID)?\b|duplicate versions for mod|Duplicate mandatory dependencies/i.test(text)) {
    return { type: 'duplicate', message: 'Ein Mod wurde mehrmals gefunden. Prüfe, ob zwei Dateien dieselbe Mod-ID haben.', modId: fromMod };
  }
  if (/GLFW error (?:6554[23]|6554[45])|pixel format not accelerated|Failed to create (?:OpenGL|GLFW)|No OpenGL context|Driver does not support OpenGL|VK_ERROR_INCOMPATIBLE_DRIVER/i.test(text)) {
    return { type: 'graphics', message: 'Minecraft konnte den Grafiktreiber oder die benötigte Grafikschnittstelle nicht verwenden.' };
  }
  if (/Mixin apply failed|MixinApplyError|MixinTransformerError|InvalidMixinException|incompatible (?:mod set|mods found|with mod)/i.test(text)) {
    return { type: 'conflict', message: 'Ein Mod konnte eine Spielklasse nicht ändern oder ist mit einem anderen Mod inkompatibel.', modId: fromMod };
  }
  return null;
}

function readText(file, tail) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(size, MAX_REPORT));
    const length = fs.readSync(fd, buffer, 0, buffer.length, tail ? size - buffer.length : 0);
    return buffer.subarray(0, length).toString('utf8');
  } finally { fs.closeSync(fd); }
}

module.exports = function crashDiagnostics({ instDir, readInst, entryPath, readZip, settings, idle }) {
  const cache = new Map();
  function directory(id) {
    if (typeof id !== 'string' || /[\\/:]/.test(id) || id === '.' || id === '..' || readInst(id).id !== id) throw new Error('Ungültige Instanz.');
    const dir = instDir(id);
    if (fs.lstatSync(dir).isSymbolicLink()) throw new Error('Verknüpfte Instanzordner werden nicht ausgewertet.');
    return dir;
  }
  function fileAt(dir, name) {
    if (fs.lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink()) return null;
    const file = path.join(dir, name);
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    return stat?.isFile() ? { file, at: stat.mtimeMs, size: stat.size } : null;
  }
  function jarModIds(instance, mod) {
    const file = entryPath(instance.id, mod);
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.size > 96 * 1024 * 1024) return [];
    const known = cache.get(file);
    if (known?.mtime === stat.mtimeMs && known.size === stat.size) return known.ids;
    let ids = [];
    try {
      const entries = readZip(fs.readFileSync(file));
      for (const entry of entries) {
        if (!['fabric.mod.json', 'quilt.mod.json', 'META-INF/mods.toml', 'META-INF/neoforge.mods.toml'].includes(entry.name)) continue;
        const text = entry.data(256 * 1024).toString('utf8');
        if (entry.name.endsWith('.json')) {
          const data = JSON.parse(text);
          ids.push(data.id || data.quilt_loader?.id);
        } else {
          for (const block of text.split(/^\s*\[\[mods\]\]\s*$/m).slice(1)) {
            ids.push(/^\s*modId\s*=\s*['"]([\w.-]+)['"]/m.exec(block.split(/^\s*\[/m)[0])?.[1]);
          }
        }
      }
    } catch {}
    ids = ids.filter((value) => typeof value === 'string' && ID.test(value));
    if (cache.size >= 500) cache.clear();
    cache.set(file, { mtime: stat.mtimeMs, size: stat.size, ids });
    return ids;
  }

  async function list(id) {
    const dir = directory(id);
    if (settings().crashDiagnostics === false) return [];
    const inst = readInst(id);
    const reports = path.join(dir, 'crash-reports');
    const sources = fs.lstatSync(reports, { throwIfNoEntry: false })?.isDirectory()
      ? fs.readdirSync(reports).filter((name) => REPORT.test(name)).flatMap((name) => {
        const found = fileAt(reports, name);
        return found ? [{ ...found, key: name }] : [];
      }) : [];
    const snapshotDir = path.join(dir, '.modstack-crashes');
    const log = fileAt(path.join(dir, 'logs'), 'latest.log');
    if (log) {
      const latest = readText(log.file, true);
      const crash = diagnose(latest);
      const fatal = /\b(?:ERROR|FATAL|Exception in thread|Caused by|Unmet dependency listing)\b|\bwhich is missing\b/i.test(latest);
      if (crash && fatal && await idle(id).catch(() => false)) {
        const key = 'log-' + createHash('sha256').update(latest).digest('hex').slice(0, 24) + '.txt';
        if (!sources.some((report) => Math.abs(report.at - log.at) < 60000) && !fileAt(snapshotDir, key)) {
          if (fs.lstatSync(snapshotDir, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('Der Diagnoseordner ist eine Verknüpfung.');
          fs.mkdirSync(snapshotDir, { recursive: true });
          try {
            const file = path.join(snapshotDir, key);
            fs.writeFileSync(file, latest, { flag: 'wx' });
            fs.utimesSync(file, new Date(log.at), new Date(log.at));
          } catch (error) { if (error.code !== 'EEXIST') throw error; }
        }
      }
    }
    if (fs.lstatSync(snapshotDir, { throwIfNoEntry: false })?.isDirectory()) {
      for (const name of fs.readdirSync(snapshotDir).filter((name) => /^log-[a-f\d]{24}\.txt$/.test(name))) {
        const found = fileAt(snapshotDir, name);
        if (found) sources.push({ ...found, key: name });
      }
    }
    let modsById;
    return sources.sort((a, b) => b.at - a.at).map(({ file, key, at, size }) => {
      const text = readText(file, false);
      const info = diagnose(text) || { type: 'unknown', message: 'Der Bericht enthält einen Absturz ohne eindeutig erkennbare Ursache.' };
      if (info.modId && !modsById) {
        modsById = new Map();
        for (const mod of inst.mods.filter((m) => (!m.kind || m.kind === 'mod') && !m.disabled)) {
          try { for (const modId of jarModIds(inst, mod)) modsById.set(modId.toLowerCase(), mod); } catch {}
        }
      }
      const mod = info.modId ? modsById.get(info.modId.toLowerCase()) : null;
      return { ...info, key, at, truncated: size > MAX_REPORT,
        mod: mod ? { title: mod.title, file: mod.file, versionId: mod.versionId } : null };
    });
  }

  function report(id, key) {
    const dir = directory(id);
    const sub = typeof key === 'string' && (REPORT.test(key) ? 'crash-reports' : /^log-[a-f\d]{24}\.txt$/.test(key) ? '.modstack-crashes' : '');
    const found = sub && fileAt(path.join(dir, sub), key);
    if (!found) throw new Error('Crash-Report nicht gefunden.');
    return { ...found, text: readText(found.file, false) };
  }
  return { list, report, jarModIds };
};
module.exports.diagnose = diagnose;
