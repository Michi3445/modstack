const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const HISTORY_ID = /^[a-f\d-]{36}$/;
const identity = (mod) => (mod.kind || 'mod') + ':' + (mod.projectId || mod.file);
const versionMatches = (a, b) => a && b && identity(a) === identity(b) && a.file === b.file && a.versionId === b.versionId;

module.exports = function modHistory({ instDir, entryPath, saveInst, settings }) {
  function folder(id) {
    const dir = path.join(instDir(id), '.modstack-history');
    if (fs.lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('Der Verlaufsordner ist eine Verknüpfung.');
    return dir;
  }

  function regular(file) {
    const item = fs.lstatSync(file, { throwIfNoEntry: false });
    if (item && !item.isFile()) throw new Error('Eine Mod-Datei ist keine reguläre Datei.');
    return item;
  }

  function records(inst) {
    return (Array.isArray(inst.history) ? inst.history : [])
      .filter((record) => record && HISTORY_ID.test(record.id) && record.old && regular(path.join(folder(inst.id), record.id)));
  }

  function move(source, dest, done) {
    if (fs.existsSync(dest)) throw new Error('Die Datei ist bereits vorhanden: ' + path.basename(dest));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(source, dest);
    done.push([source, dest]);
  }

  function rollback(done) {
    for (const [source, dest] of done.reverse()) fs.renameSync(dest, source);
  }

  function discard(dir, keys) {
    for (const key of keys) {
      try { fs.rmSync(path.join(dir, key), { force: true }); } catch {}
    }
  }

  function replace(inst, old, next, staged) {
    const dir = folder(inst.id);
    const source = entryPath(inst.id, old);
    const key = randomUUID();
    const archived = path.join(dir, key);
    const oldPresent = regular(source);
    const keep = settings().historyEnabled !== false && oldPresent;
    const recordsBefore = records(inst);
    const required = Number.isInteger(settings().historyLimit) ? Math.max(1, Math.min(30, settings().historyLimit)) : 5;
    const removed = [];
    const steps = [];
    if (keep) recordsBefore.push({ id: key, at: new Date().toISOString(), old, next });
    const counts = new Map();
    const history = recordsBefore.reverse().filter((item) => {
      const id = identity(item.old);
      const count = (counts.get(id) || 0) + 1;
      counts.set(id, count);
      if (count > required) removed.push(item.id);
      return count <= required;
    }).reverse();
    const mods = next ? inst.mods.map((item) => item === old ? next : item) : inst.mods.filter((item) => item !== old);
    try {
      if (oldPresent) move(source, archived, steps);
      if (staged) move(staged, entryPath(inst.id, next), steps);
      saveInst({ ...inst, mods, history });
    } catch (error) {
      rollback(steps);
      throw error;
    }
    discard(dir, keep ? removed : [...removed, key]);
  }

  function undo(inst, key, through) {
    const history = records(inst);
    const index = history.findIndex((record) => record.id === key);
    if (index < 0) throw new Error('Die frühere Version ist nicht mehr verfügbar.');
    const selected = (through ? history.slice(index) : [history[index]]).reverse();
    const removed = new Set(selected.map((record) => record.id));
    const dir = folder(inst.id);
    let mods = [...inst.mods];
    const steps = [], temporary = [];
    try {
      for (const record of selected) {
        const current = mods.find((mod) => identity(mod) === identity(record.old));
        if (record.next ? !versionMatches(current, record.next) : current) {
          throw new Error('Der Mod wurde seitdem geändert. Mache zuerst die neueren Änderungen rückgängig.');
        }
        const original = current ? { ...record.old, disabled: current.disabled } : record.old;
        if (current && regular(entryPath(inst.id, current))) {
          const key = randomUUID();
          move(entryPath(inst.id, current), path.join(dir, key), steps);
          temporary.push(key);
        }
        move(path.join(dir, record.id), entryPath(inst.id, original), steps);
        mods = current ? mods.map((mod) => mod === current ? original : mod) : [...mods, original];
      }
      saveInst({ ...inst, mods, history: history.filter((record) => !removed.has(record.id)) });
    } catch (error) {
      rollback(steps);
      throw error;
    }
    discard(dir, temporary);
  }

  function bytes(inst) {
    const dir = folder(inst.id);
    return records(inst).reduce((total, record) => total + fs.statSync(path.join(dir, record.id)).size, 0);
  }

  function clear(inst) {
    const history = records(inst);
    saveInst({ ...inst, history: [] });
    discard(folder(inst.id), history.map((record) => record.id));
  }

  function previous(inst, file) {
    const current = inst.mods.find((mod) => mod.file === file);
    if (!current) return null;
    return records(inst).findLast((record) => versionMatches(current, record.next))?.id || null;
  }

  return { replace, list: records, undo, previous, bytes, clear };
};
