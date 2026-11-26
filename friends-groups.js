const { randomBytes } = require('node:crypto');

const GROUP_ID = /^g-[a-f0-9]{32}$/;
const UID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_MEMBERS = 12;
const HISTORY = { orderBy: 'at', limitToLast: 50 };

function registerGroups({ handle, db, signedIn, readLinks, buildShareCode, clearUnread }) {
  const data = async (location, options) => (await db(location, options)).value;
  const patch = (value) => db('', { method: 'PATCH', value });
  const login = () => {
    const uid = signedIn();
    if (!uid) throw new Error('Melde dich zuerst an.');
    return uid;
  };
  function groupId(id) {
    if (typeof id !== 'string' || !GROUP_ID.test(id)) throw new Error('Ungültige Gruppe.');
    return id;
  }
  const membership = (id, uid, state) => ({
    ['groupMembers/' + id + '/' + uid]: state,
    ['groupIndex/' + uid + '/' + id]: state,
  });

  async function group(id) {
    groupId(id);
    const uid = login();
    const cards = await data('/groupCards/' + id);
    const members = await data('/groupMembers/' + id);
    if (!cards || members?.[uid] !== 'member') throw new Error('Du bist kein Mitglied dieser Gruppe.');
    return { uid, owner: cards.owner, members };
  }

  async function confirmedFriends(uid, requested) {
    if (!Array.isArray(requested) || requested.length > MAX_MEMBERS - 1 ||
        requested.some((member) => typeof member !== 'string' || !UID.test(member) || uid === member)) {
      throw new Error('Wähle bestätigte Freunde aus.');
    }
    const links = await readLinks(uid);
    const friends = new Set(Object.values(links).filter((link) => link.state === 'friends')
      .map((link) => link.sender === uid ? link.recipient : link.sender));
    const selection = [...new Set(requested)];
    if (selection.some((member) => !friends.has(member))) throw new Error('Du kannst nur bestätigte Freunde einladen.');
    return selection;
  }

  handle('groups:list', async () => {
    const uid = login();
    const index = await data('/groupIndex/' + uid) || {};
    clearUnread((id) => index[id] === 'member');
    const rows = [];
    const entries = Object.entries(index).filter(([id, state]) => GROUP_ID.test(id) && ['member', 'invited'].includes(state));
    for (let i = 0; i < entries.length; i += 8) {
      rows.push(...await Promise.all(entries.slice(i, i + 8).map(async ([id, state]) => {
        const card = await data('/groupCards/' + id).catch(() => null);
        if (!card) return null;
        return { id, name: card.name, owner: card.owner === uid, state, group: true };
      })));
    }
    return rows.filter(Boolean).sort((a, b) => a.name.localeCompare(b.name, 'de'));
  });

  handle('groups:create', async ({ name, friends } = {}) => {
    const uid = login();
    name = typeof name === 'string' ? name.trim() : '';
    if (!name || name.length > 48) throw new Error('Gib einen Gruppennamen mit bis zu 48 Zeichen ein.');
    const selected = await confirmedFriends(uid, friends);
    const id = 'g-' + randomBytes(16).toString('hex');
    const updates = { ['groupCards/' + id]: { name, owner: uid }, ...membership(id, uid, 'member') };
    for (const friend of selected) Object.assign(updates, membership(id, friend, 'invited'));
    await patch(updates);
    return { id, name, owner: true, state: 'member', group: true };
  });

  handle('groups:members', async (id) => {
    const room = await group(id);
    const rows = [];
    const members = Object.entries(room.members);
    for (let i = 0; i < members.length; i += 8) {
      rows.push(...await Promise.all(members.slice(i, i + 8).map(async ([uid, state]) => {
        const profile = await data('/profiles/' + uid).catch(() => null);
        return { uid, state, owner: uid === room.owner, self: uid === room.uid, name: profile?.name || 'Unbekanntes Profil' };
      })));
    }
    return rows.sort((a, b) => Number(b.owner) - Number(a.owner) || a.name.localeCompare(b.name, 'de'));
  });

  handle('groups:invite', async ({ id, friends } = {}) => {
    const room = await group(id);
    if (room.uid !== room.owner) throw new Error('Nur der Gruppenersteller kann weitere Freunde einladen.');
    const selected = (await confirmedFriends(room.uid, friends)).filter((uid) => !room.members[uid]);
    if (Object.keys(room.members).length + selected.length > MAX_MEMBERS) throw new Error('Eine Gruppe hat Platz für bis zu 12 Personen, einschließlich offener Einladungen.');
    if (!selected.length) return;
    await patch(Object.assign({}, ...selected.map((uid) => membership(id, uid, 'invited'))));
  });

  handle('groups:respond', async ({ id, accept } = {}) => {
    const uid = login();
    groupId(id);
    const state = await data('/groupMembers/' + id + '/' + uid);
    if (state !== 'invited') throw new Error('Diese Einladung ist nicht mehr verfügbar.');
    await patch(membership(id, uid, accept === true ? 'member' : null));
  });

  handle('groups:remove', async ({ id, uid } = {}) => {
    const room = await group(id);
    if (typeof uid !== 'string' || !UID.test(uid) || !room.members[uid] || uid === room.owner || (room.uid !== uid && room.uid !== room.owner)) {
      throw new Error('Dieses Mitglied kann nicht entfernt werden.');
    }
    await patch(membership(id, uid, null));
    if (uid === room.uid) clearUnread((group) => group !== id);
  });

  async function readChat(id, before) {
    const uid = login();
    const query = Number.isSafeInteger(before) && before > 0 ? { ...HISTORY, endAt: before } : HISTORY;
    const result = await data('/groupChats/' + groupId(id), { query });
    return Object.entries(result || {}).map(([messageId, message]) => ({ ...message, messageId, mine: message.from === uid }))
      .sort((a, b) => a.at - b.at || a.messageId.localeCompare(b.messageId, 'en'));
  }

  handle('groups:chat', (id) => readChat(id));
  handle('groups:shared', async ({ id, before } = {}) => {
    const rows = await readChat(id, before);
    const boundary = rows[0]?.at;
    return { packs: rows.filter((row) => row.kind === 'pack'),
      before: rows.length === HISTORY.limitToLast ? (boundary === before ? boundary - 1 : boundary) : null };
  });

  async function send(id, fields) {
    const room = await group(id);
    const messageId = randomBytes(16).toString('hex');
    const at = { '.sv': 'timestamp' };
    const value = { ['groupChats/' + id + '/' + messageId]: { from: room.uid, at, ...fields } };
    for (const [recipient, state] of Object.entries(room.members)) {
      if (recipient !== room.uid && state === 'member') {
        value['inbox/' + recipient + '/' + id] = { messageId, at, kind: fields.kind };
      }
    }
    await patch(value);
  }

  handle('groups:sendText', async ({ id, text } = {}) => {
    const content = typeof text === 'string' ? text.trim() : '';
    if (!content || content.length > 2000) throw new Error('Schreib eine Nachricht mit bis zu 2.000 Zeichen.');
    await send(id, { kind: 'text', content });
  });

  handle('groups:sendPack', async ({ id, instanceId } = {}) => {
    groupId(id);
    if (typeof instanceId !== 'string' || !instanceId || instanceId.length > 180) throw new Error('Wähle eine Instanz aus.');
    const { code, name, skipped } = buildShareCode(instanceId, 16000);
    if (code.length > 16000) throw new Error('Dieses Modpack ist zu groß für den Chat. Teile es als .mrpack-Datei.');
    await send(id, { kind: 'pack', content: code, title: String(name || 'Modpack').slice(0, 80), skipped: skipped.length });
  });
}

module.exports = { GROUP_ID, registerGroups };
