const fs = require('node:fs');
const path = require('node:path');
const MOD_ID = /^[A-Za-z0-9]{4,32}$/;

module.exports = function syncLocal({ readInst, saveInst, instDir, instRoot, newInstId, saveNewInst, instanceWork,
  kindOf, entryPath, resolveLoaderVersion, fetchVersion, download, history, backups }) {
  function read(id) {
    if (typeof id !== 'string' || id === '.' || id === '..' || /[\\/:]/.test(id)) throw new Error('Ungültige Instanz.');
    const inst = readInst(id);
    if (inst.id !== id || fs.lstatSync(instDir(id)).isSymbolicLink()) throw new Error('Ungültige Instanz.');
    return inst;
  }
  function bind(id, ref, loaderVersion) {
    const inst = read(id);
    if (ref) inst.sync = ref;
    else delete inst.sync;
    if (loaderVersion) inst.loaderVersion = loaderVersion;
    saveInst(inst);
    return inst;
  }
  async function manifest(id, optional) {
    if (optional != null && (!Array.isArray(optional) || optional.length > 500 || optional.some((key) => typeof key !== 'string' || !MOD_ID.test(key)))) {
      throw new Error('Ungültige optionale Mods.');
    }
    const inst = read(id);
    const entries = [], manual = [];
    for (const mod of inst.mods.filter((m) => !m.disabled)) {
      if (typeof mod.projectId !== 'string' || typeof mod.versionId !== 'string' || !MOD_ID.test(mod.projectId) || !MOD_ID.test(mod.versionId)) {
        manual.push(String(mod.file).slice(0, 200));
        continue;
      }
      entries.push([mod.projectId, { versionId: mod.versionId, kind: kindOf(mod), optional: !!optional?.includes(mod.projectId),
        title: (mod.title || mod.file).slice(0, 100), version: String(mod.version || '').slice(0, 80) }]);
    }
    const loaderVersion = await resolveLoaderVersion(inst);
    if (!loaderVersion) throw new Error('Die Loader-Version des Packs konnte nicht ermittelt werden.');
    return { name: inst.name.slice(0, 80), mc: inst.mc, loader: inst.loader, loaderVersion,
      entries: Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b, 'en'))), manual: manual.sort() };
  }
  function wanted(pack, optional) {
    if (!Array.isArray(optional) || optional.length > 500) throw new Error('Ungültige optionale Mods.');
    return Object.entries(pack.entries).filter(([id, mod]) => !mod.optional || optional.includes(id));
  }
  function plan(inst, pack, optional) {
    const selected = new Map(wanted(pack, optional));
    const installed = new Map(inst.mods.filter((m) => m.projectId).map((m) => [m.projectId, m]));
    const managed = new Set(inst.sync?.managed || []);
    const extra = inst.mods.filter((m) => !selected.has(m.projectId) && !managed.has(m.projectId) && !pack.manual.includes(m.file));
    const remove = inst.mods.filter((m) => managed.has(m.projectId) && !selected.has(m.projectId));
    const changes = [...selected].flatMap(([id, next]) => {
      const old = installed.get(id);
      if (!old || old.versionId !== next.versionId || old.disabled || kindOf(old) !== next.kind ||
          !fs.lstatSync(entryPath(inst.id, old), { throwIfNoEntry: false })?.isFile()) return [{ id, old, next }];
      return [];
    });
    const platform = inst.mc !== pack.mc || inst.loader !== pack.loader || inst.loaderVersion !== pack.loaderVersion;
    return { remove, changes, extra, platform, selected };
  }
  function diff(id, pack, optional) {
    const inst = read(id);
    const data = plan(inst, pack, optional);
    return {
      added: data.changes.filter((item) => !item.old).map(({ next }) => next.title + ' ' + next.version),
      updated: data.changes.filter((item) => item.old).map(({ old, next }) =>
        next.title + ' · ' + (old.disabled ? 'deaktiviert' : old.version || old.versionId) + ' → ' + (next.version || next.versionId)),
      removed: data.remove.map((m) => m.title || m.file),
      extra: data.extra.map((m) => m.title || m.file), extraFiles: data.extra.map((m) => m.file),
      manualMissing: pack.manual.filter((name) => !inst.mods.some((m) =>
        name === m.file && !m.disabled && fs.lstatSync(entryPath(inst.id, m), { throwIfNoEntry: false })?.isFile())),
      platform: data.platform ? `${inst.mc} / ${inst.loader} → ${pack.mc} / ${pack.loader} ${pack.loaderVersion}` : '',
    };
  }
  async function stageFiles(stage, items, pack) {
    const out = [];
    for (const [index, [projectId, mod]] of items.entries()) {
      const version = await fetchVersion(mod.versionId);
      if (version.id !== mod.versionId || version.project_id !== projectId || !version.game_versions?.includes(pack.mc) ||
          (mod.kind === 'mod' && !version.loaders?.includes(pack.loader) &&
            !(pack.loader === 'quilt' && version.loaders?.includes('fabric')))) {
        throw new Error('Die Modrinth-Version passt nicht zum Pack: ' + mod.title);
      }
      const record = version.files?.find((file) => file.primary) || version.files?.[0];
      if (!record) throw new Error('Die Modrinth-Version enthält keine Datei: ' + mod.title);
      const next = { file: record.filename, kind: mod.kind, projectId, versionId: version.id,
        version: version.version_number, title: mod.title };
      entryPath('validation', next);
      const file = path.join(stage, String(index));
      await download(record, file);
      out.push({ file, next });
    }
    return out;
  }
  function ref(key, pack, account, optional) {
    return { packId: key, account, revision: pack.revision, chat: pack.chat, role: pack.owner === account ? 'owner' : 'member',
      optional: optional.filter((id) => pack.entries[id]?.optional), managed: wanted(pack, optional).map(([id]) => id) };
  }
  const platform = (pack) => ({ mc: pack.mc, loader: pack.loader, loaderVersion: pack.loaderVersion });
  async function join(key, pack, account, optional = []) {
    fs.mkdirSync(instRoot(), { recursive: true });
    for (const id of fs.readdirSync(instRoot())) {
      let inst;
      try { inst = read(id); } catch { continue; }
      if (inst.sync?.packId === key && inst.sync.account === account) return inst;
    }
    const id = newInstId(pack.name);
    const dir = instDir(id);
    fs.mkdirSync(dir, { recursive: true });
    const stage = fs.mkdtempSync(path.join(dir, '.sync-'));
    try {
      const selected = wanted(pack, optional);
      const files = await stageFiles(stage, selected, pack);
      const inst = { id, name: pack.name, ...platform(pack), mods: files.map((file) => file.next),
        created: new Date().toISOString(), source: 'shared', sync: ref(key, pack, account, optional) };
      const paths = new Set();
      for (const file of files) {
        const target = entryPath(id, file.next);
        const normalized = target.toLowerCase();
        if (paths.has(normalized)) throw new Error('Zwei Modrinth-Dateien haben denselben Namen.');
        paths.add(normalized);
      }
      for (const file of files) {
        const target = entryPath(id, file.next);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.renameSync(file.file, target);
      }
      saveNewInst(inst);
      return inst;
    } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  }
  function apply(id, key, pack, account, optional) {
    return instanceWork(id, async () => {
      await backups.ensureIdle(id);
      const initial = read(id);
      if (initial.sync?.packId !== key || initial.sync.account !== account) throw new Error('Verknüpfung wurde geändert.');
      const before = plan(initial, pack, optional);
      if (!before.changes.length && !before.remove.length && !before.platform) {
        return bind(id, ref(key, pack, account, optional));
      }
      const stage = fs.mkdtempSync(path.join(instDir(id), '.sync-'));
      try {
        const files = await stageFiles(stage, before.changes.map(({ id, next }) => [id, next]), pack);
        await backups.snapshot(id, 'Vor Pack-Synchronisierung');
        await backups.ensureIdle(id);
        const inst = read(id);
        const current = plan(inst, pack, optional);
        if (JSON.stringify(diffFor(before)) !== JSON.stringify(diffFor(current))) throw new Error('Die Instanz hat sich geändert. Prüfe sie erneut.');
        const changes = current.remove.map((old) => ({ old, next: null }));
        for (const [index, item] of current.changes.entries()) {
          changes.push({ old: item.old, staged: files[index].file, next: files[index].next });
        }
        history.replaceMany(inst, changes, { ...platform(pack), sync: ref(key, pack, account, optional) });
        return read(id);
      } finally { fs.rmSync(stage, { recursive: true, force: true }); }
    });
  }
  function diffFor(data) {
    return [data.changes.map((item) => [item.id, item.old?.file, item.old?.versionId, !!item.old?.disabled]), data.remove.map((item) => item.file)];
  }
  return { read, bind, manifest, diff, join, apply };
};
