const { randomBytes } = require('node:crypto');
const { GROUP_ID } = require('./friends-groups');

const PACK_ID = /^s-[a-f0-9]{32}$/;
const MOD_ID = /^[A-Za-z0-9]{4,32}$/;
const UID = /^[A-Za-z0-9_-]{1,128}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9_+.\-]{0,47}$/;
const KINDS = new Set(['mod', 'resourcepack', 'shader']);
const LOADERS = new Set(['fabric', 'quilt', 'forge', 'neoforge']);
const STAMP = { '.sv': 'timestamp' };

function checkedPack(pack) {
  if (!pack || typeof pack.owner !== 'string' || !UID.test(pack.owner) ||
      ![pack.mc, pack.loaderVersion].every((value) => typeof value === 'string' && VERSION.test(value)) ||
      !LOADERS.has(pack.loader) || typeof pack.name !== 'string' || !pack.name.trim() || pack.name.length > 80 ||
      !Number.isSafeInteger(pack.revision) || pack.revision < 1 || pack.revision > 1000000) {
    throw new Error('Das gemeinsame Pack enthält ungültige Angaben.');
  }
  const entries = Object.entries(pack.entries || {});
  const manual = Object.values(pack.manual || {});
  if (entries.length > 500 || manual.length > 100 ||
      entries.some(([id, entry]) => !MOD_ID.test(id) || !entry || typeof entry.versionId !== 'string' || !MOD_ID.test(entry.versionId) ||
        !KINDS.has(entry.kind) || typeof entry.optional !== 'boolean' ||
        typeof entry.title !== 'string' || !entry.title.length || entry.title.length > 100 ||
        typeof entry.version !== 'string' || entry.version.length > 80) ||
      manual.some((name) => typeof name !== 'string' || !name.length || name.length > 200 || /[\\/:]/.test(name))) {
    throw new Error('Das gemeinsame Pack enthält ungültige oder zu viele Dateien.');
  }
  return { ...pack, entries: Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b, 'en'))), manual };
}

function releaseNote(before, after) {
  if (!before) return 'Gemeinsames Pack erstellt';
  const plus = Object.keys(after.entries).filter((id) => !before.entries[id]).length;
  const minus = Object.keys(before.entries).filter((id) => !after.entries[id]).length;
  const update = Object.keys(after.entries).filter((id) => before.entries[id] &&
    (after.entries[id].versionId !== before.entries[id].versionId || after.entries[id].optional !== before.entries[id].optional)).length;
  return `Pack aktualisiert: +${plus} Dateien, ${update} geändert, −${minus} Dateien`;
}

module.exports = function registerSync({ handle, db, uid, chatId, readLinks, send, groupSend, enabled, local }) {
  const packPath = (key) => {
    if (typeof key !== 'string' || !PACK_ID.test(key)) throw new Error('Ungültige Pack-ID.');
    return '/syncPacks/' + key;
  };
  const read = async (key, headers) => {
    const result = await db(packPath(key), { headers });
    const wire = result.value;
    const entries = Object.fromEntries(Object.values(wire?.entries || {}).map(({ projectId, ...data }) => [projectId, data]));
    return { ...result, value: checkedPack({ ...wire, entries }) };
  };
  const wirePack = (pack) => ({
    ...pack, at: STAMP,
    entries: Object.fromEntries(Object.entries(pack.entries).map(([projectId, entry], i) => ['e' + i, { projectId, ...entry }])),
  });
  const auth = () => {
    if (!enabled()) throw new Error('Pack-Synchronisierung ist in den Optionen ausgeschaltet.');
    const account = uid();
    if (!account) throw new Error('Melde dich zuerst unter Freunde an.');
    return account;
  };
  async function membership(chat, account) {
    if (GROUP_ID.test(chat)) {
      const { value } = await db('/groupIndex/' + account + '/' + chat);
      return value === 'member';
    }
    return (await readLinks(account))[chatId(chat)]?.state === 'friends';
  }
  function sendCard(key, pack) {
    return (GROUP_ID.test(pack.chat) ? groupSend : send)(pack.chat, {
      kind: 'sync', content: key, title: pack.name, revision: pack.revision, summary: pack.summary,
    });
  }
  function localSync(id, account) {
    const ref = local.read(id).sync;
    if (!ref || ref.account !== account || !PACK_ID.test(ref.packId)) throw new Error('Diese Instanz ist nicht mit deinem Konto verknüpft.');
    return ref;
  }
  function summaryFor(key, pack) {
    return { key, name: pack.name, revision: pack.revision, owner: pack.owner === uid(), manual: pack.manual,
      optional: Object.entries(pack.entries).filter(([, item]) => item.optional).map(([id, item]) => ({ id, title: item.title })) };
  }

  handle('sync:create', async ({ id, chat, optional } = {}) => {
    const account = auth();
    if (local.read(id).sync) throw new Error('Diese Instanz ist bereits verknüpft.');
    if (typeof chat !== 'string' || !await membership(chat, account)) throw new Error('Wähle einen bestätigten Chat.');
    const key = 's-' + randomBytes(16).toString('hex');
    const draft = await local.manifest(id, optional);
    const pack = checkedPack({ ...draft, owner: account, chat, revision: 1, summary: 'Gemeinsames Pack erstellt' });
    await db(packPath(key), { method: 'PUT', value: wirePack(pack) });
    local.bind(id, { packId: key, chat, revision: 1, account, role: 'owner', optional: optional || [], managed: Object.keys(pack.entries) }, pack.loaderVersion);
    await sendCard(key, pack);
    return summaryFor(key, pack);
  });

  handle('sync:card', async ({ key, chat } = {}) => {
    auth();
    const { value } = await read(key);
    if (value.chat !== chat) throw new Error('Diese Karte gehört zu einem anderen Chat.');
    return summaryFor(key, value);
  });

  handle('sync:join', async ({ key, chat, optional } = {}) => {
    const account = auth();
    const { value } = await read(key);
    if (value.chat !== chat) throw new Error('Diese Karte gehört zu einem anderen Chat.');
    return local.join(key, value, account, optional);
  });

  handle('sync:status', async ({ id, optional } = {}) => {
    const account = auth();
    const ref = localSync(id, account);
    if (!await membership(ref.chat, account)) {
      local.bind(id, null);
      return { detached: true };
    }
    const { value } = await read(ref.packId);
    if (value.chat !== ref.chat) throw new Error('Die Verknüpfung stimmt nicht mit dem Chat überein.');
    const role = value.owner === account ? 'owner' : 'member';
    if (ref.role !== role) local.bind(id, { ...ref, role });
    return { ...summaryFor(ref.packId, value), ...local.diff(id, value, optional ?? ref.optional), current: ref.revision };
  });

  handle('sync:publish', async ({ id, optional, announce, transfer } = {}) => {
    const account = auth();
    const ref = localSync(id, account);
    const { value: previous, etag } = await read(ref.packId, { 'X-Firebase-ETag': 'true' });
    if (previous.owner !== account) throw new Error('Nur der Pack-Besitzer kann Änderungen veröffentlichen.');
    if (!etag) throw new Error('Die Revision konnte nicht geprüft werden.');
    if (transfer && (!UID.test(transfer) || transfer === account ||
        (GROUP_ID.test(previous.chat)
          ? (await db('/groupMembers/' + previous.chat + '/' + transfer)).value !== 'member'
          : !previous.chat.split('~').includes(transfer)))) throw new Error('Wähle ein Mitglied des Chats.');
    const draft = transfer ? previous : await local.manifest(id, optional ?? ref.optional);
    const next = checkedPack({ ...draft, owner: transfer || account, chat: previous.chat, revision: previous.revision + 1 });
    const changed = transfer || JSON.stringify(previous.entries) !== JSON.stringify(next.entries) ||
      JSON.stringify(previous.manual) !== JSON.stringify(next.manual) ||
      ['name', 'mc', 'loader', 'loaderVersion'].some((field) => previous[field] !== next[field]);
    if (!changed) {
      if (announce) await sendCard(ref.packId, previous);
      return summaryFor(ref.packId, previous);
    }
    next.summary = transfer ? 'Pack-Besitz wurde übertragen' : releaseNote(previous, next);
    await db(packPath(ref.packId), { method: 'PUT', headers: { 'If-Match': etag }, value: wirePack(next) });
    local.bind(id, { ...ref, revision: next.revision, role: transfer ? 'member' : 'owner',
      optional: optional ?? ref.optional, managed: Object.keys(next.entries) }, next.loaderVersion);
    await sendCard(ref.packId, next);
    return summaryFor(ref.packId, next);
  });

  handle('sync:apply', async ({ id, revision, optional } = {}) => {
    const account = auth();
    const ref = localSync(id, account);
    const { value } = await read(ref.packId);
    if (value.revision !== revision) throw new Error('Es gibt eine neuere Revision. Prüfe die Änderungen erneut.');
    return local.apply(id, ref.packId, value, account, optional ?? ref.optional);
  });

  handle('sync:disconnect', (id) => {
    return local.bind(id, null);
  });
};
