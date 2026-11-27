const packSyncState = new Map();
const pendingSyncChanges = new Set();
let syncingStatus = false;
let publishingSync = false;

function autoSharePackChanges() {
  return S.packSyncAuto !== false;
}

function syncButton(label, action, primary = false) {
  const button = document.createElement('button');
  Object.assign(button, { type: 'button', className: primary ? 'primary sm' : 'ghost sm', textContent: label });
  button.onclick = async () => {
    button.disabled = true;
    try { await action(); } catch (error) { toast(errText(error), true); }
    finally { button.disabled = false; }
  };
  return button;
}

function syncDialog(title, picker, options, selected, confirmLabel) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'sync-dialog';
    const head = document.createElement('div'); head.className = 'dh'; head.textContent = title;
    const body = document.createElement('div'); body.className = 'db';
    let select;
    if (picker?.length) {
      const label = document.createElement('label'); label.textContent = 'Chat oder Mitglied';
      select = document.createElement('select');
      for (const item of picker) select.add(new Option(item.name, item.id));
      label.append(select); body.append(label);
    }
    if (options.length) {
      const legend = document.createElement('strong'); legend.textContent = 'Optionale Dateien'; body.append(legend);
      const list = document.createElement('div'); list.className = 'sync-choices';
      for (const item of options) {
        const label = document.createElement('label');
        const check = document.createElement('input');
        Object.assign(check, { type: 'checkbox', value: item.id, checked: selected.includes(item.id) });
        label.append(check, document.createTextNode(item.title));
        list.append(label);
      }
      body.append(list);
    }
    const actions = document.createElement('div'); actions.className = 'df';
    let choice;
    actions.append(syncButton('Abbrechen', () => dialog.close()), syncButton(confirmLabel, () => {
      choice = { pick: select?.value, optional: [...body.querySelectorAll('input:checked')].map((item) => item.value) };
      dialog.close();
    }, true));
    dialog.append(head, body, actions);
    dialog.onclose = () => { dialog.remove(); resolve(choice); };
    document.body.append(dialog);
    dialog.showModal();
    if (select) fancySelect(select);
  });
}

async function setupPackSync(instance) {
  const [friends, groups] = await Promise.all([api.invoke('friends:list'), api.invoke('friends:groups:list')]);
  const chats = [...friends.filter((friend) => friend.accepted), ...groups.filter((group) => group.state === 'member')];
  if (!chats.length) { toast('Füge zuerst Freunde hinzu oder tritt einer Gruppe bei.'); return; }
  const options = instance.mods.filter((m) => m.projectId && m.versionId && !m.disabled)
    .map((m) => ({ id: m.projectId, title: m.title || m.file }));
  const choice = await syncDialog('Mit Gruppe/Freund synchronisieren', chats, options, [], 'Verknüpfen');
  if (!choice) return;
  await work('Verknüpfe Modpack …', () => api.invoke('friends:sync:create', { id: instance.id, chat: choice.pick, optional: choice.optional }));
  await load(instance.id);
  toast('Gemeinsames Pack im Chat geteilt');
}

function packDiffText(data) {
  return [
    data.platform && 'Minecraft / Loader: ' + data.platform,
    ...data.added.map((item) => '+ ' + item),
    ...data.updated.map((item) => '↻ ' + item),
    ...data.removed.map((item) => '− ' + item),
    ...data.manualMissing.map((item) => 'Manuell installieren: ' + item),
    ...data.extra.map((item) => 'Nicht im Gruppen-Pack: ' + item),
  ].filter(Boolean).join('\n');
}

async function checkPackBeforeJoin(instance, optional = instance.sync.optional, apply = false) {
  const data = await api.invoke('friends:sync:status', { id: instance.id, optional });
  if (data.detached) { await load(instance.id); toast('Das Pack ist jetzt eine normale Instanz.'); return; }
  const different = data.platform || data.added.length || data.updated.length || data.removed.length;
  const text = packDiffText(data);
  if (!apply && !different && !data.manualMissing.length && !data.extra.length) {
    toast('Alles gleich · Pack-Version ' + data.revision);
    return;
  }
  if (!await ask({
    title: apply ? 'Pack-Update übernehmen?' : 'Pack vergleichen · Version ' + data.revision,
    text: text || 'Die Mod-Versionen stimmen überein.',
    okText: apply ? 'Übernehmen' : 'Schließen', danger: apply && !!data.removed.length,
  }) || !apply) return;
  await work('Übernehme gemeinsames Pack …', () => api.invoke('friends:sync:apply', { id: instance.id, revision: data.revision, optional }));
  await load(instance.id);
  toast('Pack auf Version ' + data.revision + ' gebracht');
}

async function updatePackSyncStatus() {
  if (syncingStatus || S.packSync === false) return;
  const linked = insts.filter((instance) => instance.sync);
  if (!linked.length) return;
  syncingStatus = true;
  try {
    let detached = false;
    for (const instance of linked) {
      try {
        const data = await api.invoke('friends:sync:status', { id: instance.id });
        if (data.detached) { packSyncState.delete(instance.id); detached = true; }
        else packSyncState.set(instance.id, data);
      } catch { packSyncState.delete(instance.id); }
    }
    if (detached) await load();
    else { renderList(); drawPackSyncBanner(); if (view === 'inst' && tab === 'mods') drawMods(); }
  } finally { syncingStatus = false; }
}

function drawPackSyncBanner() {
  const banner = $('#packSyncBanner');
  const data = cur && packSyncState.get(cur.id);
  const show = view === 'inst' && S.packSync !== false && cur?.sync && data && !data.owner && data.revision > data.current;
  banner.hidden = !show;
  if (!show) return;
  const instance = cur;
  banner.querySelector('span').textContent = 'Pack-Version ' + data.revision + ' verfügbar';
  banner.querySelectorAll('button')[0].onclick = () => checkPackBeforeJoin(instance).catch((error) => toast(errText(error), true));
  banner.querySelectorAll('button')[1].onclick = () => checkPackBeforeJoin(instance, instance.sync.optional, true).catch((error) => toast(errText(error), true));
}

function renderPackSync(container, instance) {
  const panel = container.querySelector('.pack-sync');
  if (S.packSync === false) return;
  panel.hidden = false;
  if (!instance.sync) {
    panel.append(syncButton('Mit Gruppe/Freund synchronisieren', () => setupPackSync(instance), true));
    return;
  }
  const actions = document.createElement('div'); actions.className = 'opts';
  actions.append(syncButton('Vor dem Joinen prüfen', () => checkPackBeforeJoin(instance)));
  actions.append(syncButton('Verknüpfung lösen', async () => {
    if (await ask({ title: 'Verknüpfung lösen?', text: 'Die lokale Instanz bleibt erhalten.', okText: 'Lösen' })) {
      await api.invoke('friends:sync:disconnect', instance.id);
      await load(instance.id);
    }
  }));
  panel.append(actions);
  api.invoke('friends:sync:status', { id: instance.id }).then((data) => {
    if (!panel.isConnected) return;
    if (data.detached) { load(instance.id); return; }
    const status = document.createElement('p');
    status.textContent = data.name + ' · Pack-Version ' + data.current + ' von ' + data.revision;
    actions.before(status);
    if (data.owner) {
      actions.append(syncButton('Pack im Chat teilen', async () => {
        const options = instance.mods.filter((m) => m.projectId && m.versionId && !m.disabled)
          .map((m) => ({ id: m.projectId, title: m.title || m.file }));
        const choice = await syncDialog('Pack im Chat teilen', [], options, instance.sync.optional, 'Teilen');
        if (choice) await publishSync(instance.id, { optional: choice.optional, announce: true });
      }));
      actions.append(syncButton('Besitz übertragen', async () => {
        const chat = instance.sync.chat;
        const rows = chat.startsWith('g-') ? await api.invoke('friends:groups:members', chat) : await api.invoke('friends:list');
        const members = rows.filter((row) => chat.startsWith('g-') ? row.state === 'member' && !row.self : row.id === chat && row.accepted)
          .map((row) => ({ id: row.uid, name: row.name }));
        if (!members.length) { toast('In diesem Chat gibt es kein weiteres Mitglied.'); return; }
        const choice = await syncDialog('Pack-Besitz übertragen', members, [], [], 'Übertragen');
        if (choice) await publishSync(instance.id, { transfer: choice.pick });
      }));
    } else {
      actions.append(syncButton('Übernehmen', async () => {
        const choice = data.optional.length ? await syncDialog('Optionale Dateien', [], data.optional, instance.sync.optional, 'Änderungen ansehen') : { optional: [] };
        if (choice) await checkPackBeforeJoin(instance, choice.optional, true);
      }, true));
    }
  }).catch((error) => {
    const hint = document.createElement('p'); hint.textContent = errText(error); actions.before(hint);
  });
}

async function publishSync(id, options = {}) {
  await api.invoke('friends:sync:publish', { id, ...options });
  await load();
  toast('Pack-Synchronisierung aktualisiert');
}

async function sendPendingSync() {
  if (publishingSync || busy || S.packSync === false) return;
  const [id] = pendingSyncChanges;
  if (!id) return;
  const automatic = autoSharePackChanges();
  if (!automatic && document.querySelector('dialog[open]')) return;
  publishingSync = true;
  pendingSyncChanges.delete(id);
  try {
    const instance = insts.find((item) => item.id === id);
    if (instance?.sync && (automatic || await ask({
      title: 'Pack-Änderungen im Chat teilen?', text: 'Teile die aktuelle Version von „' + instance.name + '“ im verknüpften Chat.',
      okText: 'Teilen',
    }))) await publishSync(id);
  } catch (error) { toast(errText(error), true); }
  finally {
    publishingSync = false;
    if (pendingSyncChanges.size) queueMicrotask(sendPendingSync);
  }
}

function renderSharedSyncCard(bubble, row, chat, closeProfile = () => {}) {
  const title = document.createElement('strong');
  title.textContent = 'Gemeinsames Pack: ' + row.title + ' · Version ' + row.revision;
  const summary = document.createElement('small'); summary.textContent = row.summary;
  bubble.append(title, summary);
  if (S.packSync === false) return;
  bubble.append(syncButton('Beitreten', async () => {
    closeProfile();
    const linked = insts.find((instance) => instance.sync?.packId === row.content);
    if (linked) { openPackSettings(linked); return; }
    const card = await api.invoke('friends:sync:card', { key: row.content, chat });
    if (card.manual.length && !await ask({ title: 'Manuelle Dateien', text: card.manual.join('\n'), okText: 'Weiter' })) return;
    const choice = await syncDialog('Gemeinsames Pack beitreten', [], card.optional, [], 'Beitreten');
    if (!choice) return;
    const instance = await work('Lade gemeinsames Pack …', () => api.invoke('friends:sync:join', { key: row.content, chat, optional: choice.optional }));
    await load(instance.id);
  }, true));
}

api.onPackSyncChanged((id) => { pendingSyncChanges.add(id); sendPendingSync(); });
api.onFriendChat((event) => { if (event.groupsChanged || event.contactsChanged || event.arrived?.some((item) => item.kind === 'sync')) updatePackSyncStatus(); });
window.addEventListener('focus', updatePackSyncStatus);
setInterval(() => { sendPendingSync(); }, 1000);
