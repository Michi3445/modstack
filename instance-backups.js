const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const exec = promisify(execFile);
const SNAPSHOT_ID = /^[a-f\d-]{36}$/;
const BACKUP_PATHS = new Set(['saves', 'config', 'options.txt']);
const retention = (value) => Number.isInteger(value) ? Math.max(1, Math.min(50, value)) : 10;

module.exports = function instanceBackups({ root, instDir, readInst, running, settings, status }) {
  function resolveInst(id) {
    if (typeof id !== 'string' || !id || id === '.' || id === '..' || /[\\/:]/.test(id) || readInst(id).id !== id) {
      throw new Error('Ungültige Instanz.');
    }
    const dir = instDir(id);
    if (fs.lstatSync(dir).isSymbolicLink()) throw new Error('Verknüpfte Instanzordner werden nicht gesichert.');
    const folder = path.join(root, id);
    if ([root, folder].some((p) => fs.lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink())) {
      throw new Error('Verknüpfte Backup-Ordner werden nicht verwendet.');
    }
    return { dir, folder };
  }

  function records(folder) {
    if (!fs.existsSync(folder)) return [];
    return fs.readdirSync(folder, { withFileTypes: true }).flatMap((item) => {
      const key = item.name.slice(0, -5);
      if (!item.isFile() || !item.name.endsWith('.json') || !SNAPSHOT_ID.test(key)) return [];
      try {
        const data = JSON.parse(fs.readFileSync(path.join(folder, item.name), 'utf8'));
        const zip = fs.lstatSync(path.join(folder, key + '.zip'));
        if (!zip.isFile() || typeof data.at !== 'string' || !Number.isFinite(Date.parse(data.at)) ||
          !Array.isArray(data.worlds) || !Array.isArray(data.paths) || !data.paths.length ||
          data.paths.some((p) => !BACKUP_PATHS.has(p)) || new Set(data.paths).size !== data.paths.length) return [];
        return [{ ...data, id: key, bytes: zip.size }];
      } catch { return []; }
    }).sort((a, b) => b.at.localeCompare(a.at));
  }

  function list(id) { return records(resolveInst(id).folder); }

  async function ensureIdle(id) {
    const processes = await running();
    if (processes.some((active) => active.toLowerCase() === id.toLowerCase())) {
      throw new Error('Schließe Minecraft für diese Instanz, bevor du Welten sicherst oder wiederherstellst.');
    }
  }

  function zipCommand(mode, values) {
    const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const script = Buffer.from(fs.readFileSync(path.join(__dirname, 'instance-backup.ps1'), 'utf8'), 'utf16le').toString('base64');
    return exec(exe, ['-NoProfile', '-NonInteractive', '-EncodedCommand', script], {
      windowsHide: true, env: { ...process.env, MODSTACK_BACKUP_JOB: JSON.stringify({ mode, ...values }) },
    }).catch((error) => {
      if (/MODSTACK_WORLD_LOCK/.test(error.stderr || '')) throw new Error('Eine Welt ist gesperrt. Beende Minecraft und versuche es erneut.');
      throw new Error(mode === 'create' ? 'Die ZIP-Sicherung konnte nicht erstellt werden.' : 'Die ZIP-Sicherung konnte nicht gelesen werden.');
    });
  }

  function prune(folder) {
    const old = records(folder).slice(retention(settings().backupLimit));
    for (const { id } of old) {
      fs.rmSync(path.join(folder, id + '.json'), { force: true });
      fs.rmSync(path.join(folder, id + '.zip'), { force: true });
    }
  }

  async function snapshot(id, reason, options = {}) {
    const { dir, folder } = resolveInst(id);
    const paths = (options.paths || (settings().backupConfig ? ['saves', 'config', 'options.txt'] : ['saves']))
      .filter((name) => fs.existsSync(path.join(dir, name)));
    const worlds = fs.existsSync(path.join(dir, 'saves')) ? fs.readdirSync(path.join(dir, 'saves'), { withFileTypes: true })
      .filter((item) => item.isDirectory() && !item.isSymbolicLink()).map((item) => item.name) : [];
    if (!paths.length || (paths.length === 1 && paths[0] === 'saves' && !worlds.length)) {
      if (!options.required) return null;
      throw new Error('Diese Instanz enthält keine Welten oder ausgewählten Dateien zum Sichern.');
    }
    await ensureIdle(id);
    fs.mkdirSync(folder, { recursive: true });
    const key = randomUUID();
    const zip = path.join(folder, key + '.zip');
    const metadata = { at: new Date().toISOString(), reason, worlds, paths };
    status('Erstelle Welt-Backup …');
    try {
      await zipCommand('create', { dir, zip, paths });
      fs.writeFileSync(path.join(folder, key + '.json'), JSON.stringify(metadata), { flag: 'wx' });
      if (!options.keep) prune(folder);
      return { ...metadata, id: key, bytes: fs.statSync(zip).size };
    } catch (error) {
      if (!fs.existsSync(path.join(folder, key + '.json'))) fs.rmSync(zip, { force: true });
      throw error;
    }
  }

  async function beforeUpdate(id) {
    if (settings().backupsEnabled !== false) await snapshot(id, 'Vor Mod-Update');
  }

  async function daily(id) {
    if (settings().backupsEnabled === false || !settings().backupDaily) return;
    if (!list(id).some((item) => new Date(item.at).toDateString() === new Date().toDateString())) await snapshot(id, 'Tägliches Backup');
  }

  async function restore(id, key) {
    if (!SNAPSHOT_ID.test(key)) throw new Error('Ungültiges Backup.');
    const { dir, folder } = resolveInst(id);
    const backup = records(folder).find((record) => record.id === key);
    if (!backup) throw new Error('Backup nicht gefunden.');
    await ensureIdle(id);
    const stage = fs.mkdtempSync(path.join(dir, '.backup-restore-'));
    const incoming = path.join(stage, 'incoming');
    const old = path.join(stage, 'old');
    fs.mkdirSync(incoming); fs.mkdirSync(old);
    const changes = [];
    let preserveStage = false;
    try {
      await zipCommand('restore', { dir, zip: path.join(folder, key + '.zip'), paths: backup.paths, incoming });
      await snapshot(id, 'Vor Wiederherstellung', { paths: backup.paths, keep: true });
      await ensureIdle(id);
      await zipCommand('locks', { dir });
      try {
        for (const name of backup.paths) {
          const target = path.join(dir, name);
          const change = { name, displaced: false, restored: false };
          changes.push(change);
          if (fs.existsSync(target)) {
            fs.renameSync(target, path.join(old, name));
            change.displaced = true;
          }
          fs.renameSync(path.join(incoming, name), target);
          change.restored = true;
        }
      } catch (error) {
        for (const change of changes.reverse()) {
          try {
            const target = path.join(dir, change.name);
            if (change.restored) fs.renameSync(target, path.join(incoming, change.name));
            if (change.displaced) fs.renameSync(path.join(old, change.name), target);
          } catch { preserveStage = true; }
        }
        if (preserveStage) throw new Error('Die Wiederherstellung wurde unterbrochen. Die Dateien liegen in ' + stage);
        throw error;
      }
      prune(folder);
    } finally {
      if (!preserveStage) fs.rmSync(stage, { recursive: true, force: true });
    }
    status('Backup wiederhergestellt');
    return list(id);
  }

  return { list, snapshot, beforeUpdate, daily, restore, ensureIdle };
};
