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
      .filter((record) => record && HISTORY_ID.test(record.id) &&
        (record.old ? regular(path.join(folder(inst.id), record.id)) : record.next || record.config));
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

  function replaceMany(inst, changes, patch) {
    const dir = folder(inst.id);
    const recordsBefore = records(inst);
    const force = !!patch;
    const keep = force || settings().historyEnabled !== false;
    const required = Number.isInteger(settings().historyLimit) ? Math.max(1, Math.min(30, settings().historyLimit)) : 5;
    const removed = [];
    const steps = [];
    const at = new Date().toISOString();
    const batch = force ? randomUUID() : undefined;
    if (batch) recordsBefore.push({ id: batch, at, config: { mc: inst.mc, loader: inst.loader, loaderVersion: inst.loaderVersion, sync: inst.sync } });
    let mods = [...inst.mods];
    const plan = changes.map(({ old, next, staged }) => {
      const id = randomUUID();
      const source = old && entryPath(inst.id, old);
      const present = source && regular(source);
      if (keep && (present || next)) recordsBefore.push({ id, at, old: present ? old : null, next, batch });
      if (!keep && present) removed.push(id);
      mods = old ? mods.filter((item) => item !== old) : mods;
      if (next) mods.push(next);
      return { id, source: present ? source : null, next, staged };
    });
    const counts = new Map();
    const incompleteBatches = new Set();
    const history = recordsBefore.reverse().filter((item) => {
      if (item.config) return true;
      const id = identity(item.old || item.next);
      const count = (counts.get(id) || 0) + 1;
      counts.set(id, count);
      if (count > required) {
        removed.push(item.id);
        if (item.batch) incompleteBatches.add(item.batch);
      }
      return count <= required;
    }).reverse();
    try {
      for (const item of plan) if (item.source) move(item.source, path.join(dir, item.id), steps);
      for (const item of plan) if (item.staged) move(item.staged, entryPath(inst.id, item.next), steps);
      saveInst({ ...inst, ...patch, mods, history: history.filter((item) => !incompleteBatches.has(item.id)) });
    } catch (error) {
      rollback(steps);
      throw error;
    }
    discard(dir, removed);
  }

  function replace(inst, old, next, staged) {
    replaceMany(inst, [{ old, next, staged }]);
  }

  function undo(inst, key, through) {
    const history = records(inst);
    const index = history.findIndex((record) => record.id === key);
    if (index < 0) throw new Error('Die frühere Version ist nicht mehr verfügbar.');
    const selected = (through || history[index].config ? history.slice(index) : [history[index]]).reverse();
    const removed = new Set(selected.map((record) => record.id));
    const dir = folder(inst.id);
    let mods = [...inst.mods];
    let patch;
    const steps = [], temporary = [];
    try {
      for (const record of selected) {
        if (record.config) { patch = { ...record.config }; continue; }
        const current = mods.find((mod) => identity(mod) === identity(record.old || record.next));
        if (record.next ? !versionMatches(current, record.next) : current) {
          throw new Error('Der Mod wurde seitdem geändert. Mache zuerst die neueren Änderungen rückgängig.');
        }
        const original = record.old && (current ? { ...record.old, disabled: current.disabled } : record.old);
        if (current && regular(entryPath(inst.id, current))) {
          const key = randomUUID();
          move(entryPath(inst.id, current), path.join(dir, key), steps);
          temporary.push(key);
        }
        if (original) move(path.join(dir, record.id), entryPath(inst.id, original), steps);
        mods = current ? mods.filter((mod) => mod !== current) : mods;
        if (original) mods.push(original);
      }
      saveInst({ ...inst, ...patch, mods, history: history.filter((record) => !removed.has(record.id)) });
    } catch (error) {
      rollback(steps);
      throw error;
    }
    discard(dir, temporary);
  }

  function bytes(inst) {
    const dir = folder(inst.id);
    return records(inst).reduce((total, record) => total + (record.old ? fs.statSync(path.join(dir, record.id)).size : 0), 0);
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

  return { replace, replaceMany, list: records, undo, previous, bytes, clear };
};
