const { safeStorage, clipboard } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const project = require('./friends-project.json');

const UID = /^[A-Za-z0-9_-]{1,128}$/;
const ROOT = '/modstackFriends';
const LINK_ID = /^[A-Za-z0-9_-]{1,128}~[A-Za-z0-9_-]{1,128}$/;
const MESSAGE_ID = /^[a-f0-9]{32}$/;
const CHAT_QUERY = { orderBy: 'at', limitToLast: 50 };
const AUTH_ERRORS = {
  EMAIL_EXISTS: 'Für diese E-Mail gibt es bereits ein Konto.',
  INVALID_EMAIL: 'Gib eine gültige E-Mail-Adresse ein.',
  INVALID_LOGIN_CREDENTIALS: 'E-Mail oder Passwort stimmt nicht.',
  INVALID_PASSWORD: 'E-Mail oder Passwort stimmt nicht.',
  EMAIL_NOT_FOUND: 'E-Mail oder Passwort stimmt nicht.',
  TOO_MANY_ATTEMPTS_TRY_LATER: 'Zu viele Versuche. Versuch es später erneut.',
  OPERATION_NOT_ALLOWED: 'Aktiviere E-Mail/Passwort in Firebase Authentication.',
  USER_DISABLED: 'Dieses Konto ist deaktiviert.',
};

module.exports = function registerFriends(ipc, userData, readMinecraftAccount, buildShareCode, notifyChat) {
  const configFile = path.join(userData, 'friends-firebase.json');
  const sessionFile = path.join(userData, 'friends-session');
  let config, session;
  let queue = Promise.resolve();
  let inbox;

  function launcherName() {
    const name = readMinecraftAccount()?.name;
    if (typeof name !== 'string') return '';
    const trimmed = name.trim();
    return trimmed.length <= 32 ? trimmed : '';
  }

  function enqueue(fn) {
    const operation = queue.then(fn);
    queue = operation.catch(() => {});
    return operation;
  }

  function handle(name, fn) {
    ipc.handle('friends:' + name, (input) => enqueue(() => fn(input)));
  }

  function saveFile(file, data) {
    fs.mkdirSync(userData, { recursive: true });
    const temp = file + '.tmp';
    try {
      fs.writeFileSync(temp, data);
      fs.renameSync(temp, file);
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }

  function setSession(data) {
    if (!data || data.uid !== session?.uid) inbox = undefined;
    session = data;
    if (!data) fs.rmSync(sessionFile, { force: true });
    else if (safeStorage.isEncryptionAvailable()) {
      saveFile(sessionFile, safeStorage.encryptString(JSON.stringify({
        databaseURL: config.databaseURL, uid: data.uid, refreshToken: data.refreshToken,
      })));
    }
  }

  function init() {
    if (config !== undefined) return;
    try { config = JSON.parse(fs.readFileSync(configFile, 'utf8')); }
    catch { config = project; }
    if (!config || !safeStorage.isEncryptionAvailable()) return;
    try {
      const saved = JSON.parse(safeStorage.decryptString(fs.readFileSync(sessionFile)));
      if (saved.databaseURL === config.databaseURL && UID.test(saved.uid) && saved.refreshToken) session = saved;
    } catch {}
  }

  async function request(url, options) {
    try { return await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(12000) }); }
    catch { throw new Error('Firebase ist gerade nicht erreichbar. Prüfe deine Internetverbindung.'); }
  }

  async function authRequest(action, body) {
    const url = 'https://identitytoolkit.googleapis.com/v1/accounts:' + action + '?key=' + encodeURIComponent(config.apiKey);
    const res = await request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const code = String(data.error?.message || '').split(' : ')[0];
      throw new Error(AUTH_ERRORS[code] || 'Firebase Authentication fehlgeschlagen. Prüfe das Projekt und den API-Schlüssel.');
    }
    return data;
  }

  async function token() {
    if (!session) throw new Error('Melde dich zuerst an.');
    if (session.idToken && Date.now() < session.expires - 60000) return session.idToken;
    const url = 'https://securetoken.googleapis.com/v1/token?key=' + encodeURIComponent(config.apiKey);
    const res = await request(url, {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: session.refreshToken }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (['INVALID_REFRESH_TOKEN', 'TOKEN_EXPIRED', 'USER_DISABLED', 'USER_NOT_FOUND'].includes(data.error?.message)) setSession(null);
      throw new Error(session ? 'Die Firebase-Sitzung konnte nicht erneuert werden.' : 'Deine Sitzung ist abgelaufen. Melde dich erneut an.');
    }
    setSession({ uid: data.user_id, refreshToken: data.refresh_token, idToken: data.id_token, expires: Date.now() + Number(data.expires_in) * 1000 });
    return session.idToken;
  }

  async function db(location, { method = 'GET', value, query, headers = {} } = {}) {
    const url = new URL(ROOT + location + '.json', config.databaseURL);
    url.searchParams.set('auth', await token());
    for (const [key, field] of Object.entries(query || {})) url.searchParams.set(key, JSON.stringify(field));
    const res = await request(url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(value) });
    if (res.status === 412) throw new Error('Die Anfrage hat sich geändert. Aktualisiere die Liste.');
    if (res.status === 401 || res.status === 403) throw new Error('Firebase verweigert den Zugriff. Prüfe die Datenbankregeln oder aktualisiere die Liste.');
    if (!res.ok) throw new Error('Die Firebase-Datenbank konnte die Aktion nicht ausführen.');
    return { value: await res.json(), etag: res.headers.get('etag') };
  }

  handle('configure', (input) => {
    init();
    const apiKey = String(input?.apiKey || '').trim();
    const databaseURL = String(input?.databaseURL || '').trim().replace(/\/$/, '');
    if (session) throw new Error('Melde dich zuerst ab.');
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(apiKey) ||
        !/^https:\/\/[a-z0-9-]+(?:\.firebaseio\.com|\.[a-z0-9-]+\.firebasedatabase\.app)$/.test(databaseURL)) {
      throw new Error('Gib den Web-API-Schlüssel und die HTTPS-URL deiner Realtime Database ein.');
    }
    const next = { apiKey, databaseURL };
    saveFile(configFile, JSON.stringify(next, null, 2));
    config = next;
  });

  handle('status', async () => {
    init();
    if (!session) return { configured: Boolean(config) };
    try {
      const location = '/profiles/' + session.uid;
      const profile = (await db(location)).value;
      const name = launcherName();
      if (name && name !== profile?.name) await db(location, { method: 'PUT', value: { name } });
      return { configured: true, uid: session.uid, name: name || profile?.name };
    } catch (err) {
      if (!session) return { configured: true };
      throw err;
    }
  });

  handle('login', async (input) => {
    init();
    if (!config || session) throw new Error('Die Anmeldung ist gerade nicht verfügbar.');
    const email = String(input?.email || '').trim();
    const password = String(input?.password || '');
    if (!email || email.length > 254 || password.length < 6 || password.length > 256) {
      throw new Error('Gib deine E-Mail und ein Passwort mit mindestens 6 Zeichen ein.');
    }
    const data = await authRequest(input.create === true ? 'signUp' : 'signInWithPassword', { email, password, returnSecureToken: true });
    setSession({ uid: data.localId, idToken: data.idToken, refreshToken: data.refreshToken, expires: Date.now() + Number(data.expiresIn) * 1000 });
  });

  handle('resetPassword', async (input) => {
    init();
    const email = String(input || '').trim();
    if (!config || !email || email.length > 254) throw new Error('Gib deine E-Mail-Adresse ein.');
    await authRequest('sendOobCode', { requestType: 'PASSWORD_RESET', email });
  });

  handle('logout', () => { init(); setSession(null); });
  handle('copyCode', () => { if (session) clipboard.writeText('MSF-' + session.uid); });

  handle('profile', async (value) => {
    const name = launcherName() || String(value || '').trim();
    if (!session || !name || name.length > 32) throw new Error('Gib einen Namen mit bis zu 32 Zeichen ein.');
    await db('/profiles/' + session.uid, { method: 'PUT', value: { name } });
  });

  handle('list', async () => {
    if (!session) throw new Error('Melde dich zuerst an.');
    const uid = session.uid;
    await token();
    const lists = await Promise.all(['sender', 'recipient'].map((field) =>
      db('/links', { query: { orderBy: field, equalTo: uid } })));
    const links = Object.assign({}, ...lists.map(({ value }) => value));
    // Namen sind pro Freund eine kleine Abfrage, in begrenzten Gruppen.
    const rows = [];
    const entries = Object.entries(links);
    for (let i = 0; i < entries.length; i += 8) {
      rows.push(...await Promise.all(entries.slice(i, i + 8).map(async ([id, link]) => {
        const incoming = link.recipient === uid;
        const other = incoming ? link.sender : link.recipient;
        const profile = (await db('/profiles/' + other)).value;
        return { id, incoming, name: profile?.name || 'Unbekanntes Profil', accepted: link.state === 'friends' };
      })));
    }
    const state = chatInbox();
    const accepted = new Set(rows.filter((row) => row.accepted).map((row) => row.id));
    const stale = unreadChats(state).filter((id) => !accepted.has(id));
    if (stale.length) {
      for (const id of stale) state.entries[id].unread = false;
      saveInbox(state);
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name, 'de'));
  });

  handle('invite', async (code) => {
    const uid = session?.uid;
    const recipient = /^MSF-([A-Za-z0-9_-]{1,128})$/.exec(String(code || '').trim())?.[1];
    if (!uid || !recipient || uid === recipient) throw new Error('Gib den Freundescode einer anderen Person ein.');
    const profile = (await db('/profiles/' + recipient)).value;
    if (!profile) throw new Error('Zu diesem Freundescode gibt es kein Profil.');
    try {
      await db('/links/' + uid + '~' + recipient, {
        method: 'PUT', value: { sender: uid, recipient, state: 'pending' },
      });
    } catch (err) {
      const existing = await Promise.all([uid + '~' + recipient, recipient + '~' + uid].map((id) =>
        db('/links/' + id).catch(() => null)));
      if (existing.some((link) => link?.value)) throw new Error('Es gibt bereits eine Anfrage oder Freundschaft mit dieser Person.');
      throw err;
    }
  });

  handle('respond', async ({ id, accept } = {}) => {
    if (!session || !LINK_ID.test(id || '')) throw new Error('Ungültige Freundschaft.');
    const location = '/links/' + id;
    const { value, etag } = await db(location, { headers: { 'X-Firebase-ETag': 'true' } });
    if (!value || !etag || (accept === true && (value.recipient !== session.uid || value.state !== 'pending'))) {
      throw new Error('Die Anfrage ist nicht mehr verfügbar. Aktualisiere die Liste.');
    }
    await db(location, {
      method: accept === true ? 'PUT' : 'DELETE',
      value: accept === true ? { ...value, state: 'friends' } : undefined,
      headers: { 'If-Match': etag },
    });
  });

  function chatId(id) {
    if (!session || typeof id !== 'string' || !LINK_ID.test(id) || !id.split('~').includes(session.uid)) {
      throw new Error('Ungültiger Chat.');
    }
    return id;
  }

  async function sendMessage(id, fields) {
    const link = (await db('/links/' + chatId(id))).value;
    const from = session?.uid;
    if (link?.state !== 'friends' || (link.sender !== from && link.recipient !== from)) {
      throw new Error('Ihr müsst befreundet sein, um Nachrichten zu senden.');
    }
    const to = link.sender === from ? link.recipient : link.sender;
    const messageId = randomBytes(16).toString('hex');
    const at = { '.sv': 'timestamp' };
    await db('', { method: 'PATCH', value: {
      ['chat/' + id + '/' + messageId]: { from, to, at, ...fields },
      ['inbox/' + to + '/' + id]: { messageId, at, kind: fields.kind },
    } });
  }

  handle('chat', async (id) => {
    const { value } = await db('/chat/' + chatId(id), { query: CHAT_QUERY });
    return Object.entries(value || {}).map(([messageId, { from, to, ...message }]) =>
      ({ ...message, messageId, mine: from === session.uid }))
      .sort((a, b) => a.at - b.at || a.messageId.localeCompare(b.messageId, 'en'));
  });

  handle('sendText', async ({ id, text } = {}) => {
    const content = typeof text === 'string' ? text.trim() : '';
    if (!content || content.length > 2000) throw new Error('Schreib eine Nachricht mit bis zu 2.000 Zeichen.');
    await sendMessage(id, { kind: 'text', content });
  });

  handle('sendPack', async ({ id, instanceId } = {}) => {
    chatId(id);
    if (typeof instanceId !== 'string' || !instanceId || instanceId.length > 180) throw new Error('Wähle eine Instanz aus.');
    const { code, skipped, name } = buildShareCode(instanceId, 16000);
    if (code.length > 16000) throw new Error('Dieses Modpack ist zu groß für den Chat. Teile es als .mrpack-Datei.');
    await sendMessage(id, { kind: 'pack', content: code, title: String(name || 'Modpack').slice(0, 80), skipped: skipped.length });
  });

  function chatInbox() {
    if (inbox) return inbox;
    const key = createHash('sha256').update(config.databaseURL + '\n' + session.uid).digest('hex');
    const file = path.join(userData, 'friend-inbox-' + key + '.json');
    let saved;
    try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    inbox = { file, cursor: Number(saved?.cursor) || 0, entries: saved?.entries || {} };
    return inbox;
  }

  function unreadChats(state) {
    return Object.keys(state.entries).filter((id) => state.entries[id].unread);
  }

  function saveInbox(state) {
    saveFile(state.file, JSON.stringify({ cursor: state.cursor, entries: state.entries }));
  }

  handle('unread', () => {
    init();
    return session ? unreadChats(chatInbox()) : [];
  });

  handle('readChat', ({ id, messageId, at } = {}) => {
    chatId(id);
    const state = chatInbox();
    const known = state.entries[id];
    if (typeof messageId === 'string' && MESSAGE_ID.test(messageId) && Number.isSafeInteger(at) &&
        (!known || known.at < at || known.messageId === messageId)) {
      state.entries[id] = { messageId, at, unread: false };
      saveInbox(state);
    }
    return unreadChats(state);
  });

  let polling = false;
  function pollChat() {
    if (polling) return;
    polling = true;
    enqueue(async () => {
      init();
      if (!session) return;
      const state = chatInbox();
      const query = state.cursor ? { ...CHAT_QUERY, startAt: state.cursor } : CHAT_QUERY;
      const { value } = await db('/inbox/' + session.uid, { query });
      const arrived = [];
      for (const [id, mark] of Object.entries(value || {})) {
        const previous = state.entries[id];
        state.cursor = Math.max(state.cursor, mark.at);
        if (previous && (previous.messageId === mark.messageId || previous.at > mark.at)) continue;
        state.entries[id] = { messageId: mark.messageId, at: mark.at, unread: true };
        arrived.push({ id, kind: mark.kind });
      }
      if (arrived.length) {
        saveInbox(state);
        notifyChat({ arrived, unread: unreadChats(state) });
      }
    }).catch(() => {}).finally(() => { polling = false; });
  }
  setTimeout(pollChat, 2000).unref();
  setInterval(pollChat, 15000).unref();
};
