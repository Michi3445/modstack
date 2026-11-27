let activeFriendChat, friendShareInstance, messenger;
let friendsPane = 'chats', friendRequestCount = 0, groupInviteCount = 0;
let unreadFriendChats = new Set();

function markUnreadFriendChats(ids) {
  unreadFriendChats = new Set(ids);
  const rail = $('[data-v="friends"]');
  let badge = $('.rbadge', rail);
  const count = ids.length + friendRequestCount + groupInviteCount;
  if (count) {
    if (!badge) { badge = document.createElement('i'); badge.className = 'rbadge'; rail.append(badge); }
    badge.textContent = count > 99 ? '99+' : count;
  } else badge?.remove();
  for (const button of document.querySelectorAll('button[data-chat]')) {
    const unread = unreadFriendChats.has(button.dataset.chat);
    button.classList.toggle('chat-unread', unread);
    button.setAttribute('aria-label', $('strong', button).textContent + (unread ? ' · ungelesen' : ''));
  }
}

function startFriendNotifications() {
  const chime = new Audio('friend-notification.wav');
  chime.preload = 'auto';
  api.onFriendChat((event) => {
    if (event.open) {
      if (event.showGroups) friendsPane = 'groups';
      else if (event.showRequests) friendsPane = 'requests';
      setView('friends');
      if (event.showGroups || event.showRequests) messenger?.draw();
      return;
    }
    friendRequestCount = event.requests.length;
    groupInviteCount = event.groupInvites?.length || 0;
    markUnreadFriendChats(event.unread);
    if (event.sound) {
      chime.currentTime = 0;
      chime.play().catch(() => {});
    }
    if (event.toast && (event.requested || event.newGroupInvites || event.arrived.some(({ id }) => id !== activeFriendChat?.entry.id))) toast(event.toast);
    if (event.arrived.some(({ id }) => id === activeFriendChat?.entry.id)) activeFriendChat.refresh();
    if ((event.contactsChanged || event.groupsChanged) && messenger?.panel.isConnected) messenger.refresh();
  });
  window.addEventListener('focus', () => activeFriendChat?.refresh());
  api.invoke('friends:friendState').then(({ unread, requests, groupInvites }) => {
    friendRequestCount = requests.length;
    groupInviteCount = groupInvites?.length || 0;
    markUnreadFriendChats(unread);
  }).catch(() => {});
}

async function renderFriends(showSetup = false, notice = '') {
  const panel = document.createElement('section');
  panel.className = 'friends-panel';
  panel.innerHTML = '<h1>Freunde</h1><p class="friends-status" role="status"></p><div class="friends-body"></div>';
  $('#content').replaceChildren(panel);
  const status = $('.friends-status', panel);
  const body = $('.friends-body', panel);

  function button(label, handler, primary = false) {
    const el = document.createElement('button');
    el.className = primary ? 'primary' : 'ghost';
    el.type = 'button';
    el.textContent = label;
    el.onclick = handler;
    return el;
  }

  async function act(channel, data, message = '', refresh = true) {
    if (panel.dataset.busy) return;
    panel.dataset.busy = 'true';
    const controls = [...body.querySelectorAll('button')];
    controls.forEach((el) => { el.disabled = true; });
    status.textContent = 'Bitte warten …';
    status.classList.remove('err');
    try {
      await api.invoke('friends:' + channel, data);
      if (!panel.isConnected) return;
      if (refresh) renderFriends(false, message);
      else status.textContent = message;
    } catch (err) {
      status.textContent = errText(err);
      status.classList.add('err');
    } finally {
      delete panel.dataset.busy;
      controls.forEach((el) => { el.disabled = false; });
    }
  }

  function showForm(html, onSubmit) {
    const form = document.createElement('form');
    form.className = 'card friends-form';
    form.innerHTML = html;
    form.onsubmit = (e) => {
      e.preventDefault();
      onSubmit(Object.fromEntries(new FormData(form)), e.submitter);
    };
    body.append(form);
    return form;
  }

  status.textContent = 'Freunde werden geladen …';
  try {
    const state = await api.invoke('friends:status');
    if (!panel.isConnected) return;
    status.textContent = notice;
    if (!state.configured || showSetup) {
      const form = showForm(`
        <label>Web-API-Schlüssel<input name="apiKey" maxlength="100" autocomplete="off" spellcheck="false" required></label>
        <label>Realtime Database-URL<input name="databaseURL" type="url" spellcheck="false" required></label>
        <button class="primary">Firebase verbinden</button>`, (data) => act('configure', data, 'Firebase-Konfiguration gespeichert.'));
      if (state.configured) form.append(button('Zurück', () => renderFriends()));
      return;
    }
    if (!state.uid) {
      friendRequestCount = 0;
      groupInviteCount = 0;
      markUnreadFriendChats([]);
      const form = showForm(`
        <label>E-Mail-Adresse<input name="email" type="email" autocomplete="username" maxlength="254" required></label>
        <label>Passwort<input name="password" type="password" autocomplete="current-password" minlength="6" maxlength="256" required></label>
        <button class="primary">Anmelden</button><button class="ghost" value="register">Konto erstellen</button>
        `, (data, submitter) => act('login', { ...data, create: submitter?.value === 'register' }));
      form.append(button('Passwort zurücksetzen', () => {
        const email = form.elements.email;
        if (email.reportValidity()) act('resetPassword', email.value, 'Die E-Mail zum Zurücksetzen wurde angefordert.', false);
      }));
      body.append(button('Firebase ändern', () => renderFriends(true)));
      return;
    }
    if (!state.name) {
      const form = showForm(`
        <p>Im Minecraft Launcher wurde kein Name gefunden. Melde dich dort an und aktualisiere, oder gib deinen Minecraft-Namen ein.</p>
        <label>Minecraft-Name<input name="name" maxlength="32" autocomplete="nickname" required></label>
        <button class="primary">Profil speichern</button>`, ({ name }) => act('profile', name));
      form.append(button('Aktualisieren', () => renderFriends()), button('Abmelden', () => act('logout')));
      return;
    }

    mountMessenger(panel, body, state, notice, button, act);
  } catch (err) {
    status.textContent = errText(err);
    status.classList.add('err');
    body.replaceChildren(button('Erneut versuchen', () => renderFriends()), button('Abmelden', () => act('logout')));
  }
}

const minecraftHeads = new Map();
function friendAvatar({ name, avatar: custom, group }) {
  const avatar = document.createElement('span');
  avatar.className = 'message-avatar';
  avatar.textContent = Array.from(name.trim())[0]?.toUpperCase() || '?';
  avatar.setAttribute('aria-hidden', 'true');
  function show(url, pixelated) {
    if (!url) return;
    const img = new Image();
    img.alt = '';
    img.src = url;
    img.classList.toggle('skin-head', pixelated);
    img.decode().then(() => avatar.replaceChildren(img)).catch(() => {});
  }
  if (custom) show(custom, false);
  else if (!group && /^[A-Za-z0-9_]{3,16}$/.test(name)) {
    const key = name.toLowerCase();
    if (!minecraftHeads.has(key)) {
      const head = api.invoke('mc:skin', { name }).then(async (data) => {
        if (!data?.skin) return null;
        const skin = new Image();
        skin.src = data.skin;
        await skin.decode();
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 8;
        const ctx = canvas.getContext('2d');
        const scale = skin.naturalWidth / 64;
        if (!Number.isInteger(scale) || scale < 1) return null;
        ctx.drawImage(skin, 8 * scale, 8 * scale, 8 * scale, 8 * scale, 0, 0, 8, 8);
        if (skin.naturalHeight >= 16 * scale) ctx.drawImage(skin, 40 * scale, 8 * scale, 8 * scale, 8 * scale, 0, 0, 8, 8);
        return canvas.toDataURL();
      }).catch(() => { minecraftHeads.delete(key); return null; });
      minecraftHeads.set(key, head);
    }
    minecraftHeads.get(key).then((url) => show(url, true));
  }
  return avatar;
}

function friendActivity(entry) {
  return entry.status?.pack ? 'Spielt ' + entry.status.pack : entry.status ? 'In Modstack online' : '';
}

function mountMessenger(panel, body, account, notice, button, act) {
  panel.classList.add('messenger-page');
  $('h1', panel).textContent = 'Nachrichten';
  body.className = 'friends-body messenger-body';
  body.innerHTML = `
    <aside class="message-sidebar" aria-label="Unterhaltungen">
      <div class="message-side-head">
        <input type="search" class="message-search" placeholder="Freunde suchen …" aria-label="Freunde suchen">
        <button type="button" class="ghost message-add" title="Freund hinzufügen" aria-label="Freund hinzufügen">+</button>
      </div>
      <nav class="message-tabs" aria-label="Freunde"><button type="button" data-pane="chats">Chats</button><button type="button" data-pane="groups">Gruppen</button><button type="button" data-pane="requests">Anfragen</button></nav>
      <div class="message-contacts"></div>
      <details class="message-profile"><summary></summary><div></div></details>
    </aside>
    <div class="message-conversation"></div>`;
  const status = $('.friends-status', panel);
  const list = $('.message-contacts', body), stage = $('.message-conversation', body), search = $('.message-search', body);
  const profile = $('.message-profile', body);
  const summary = $('summary', profile);
  function drawOwnAvatar() { summary.replaceChildren(friendAvatar(account), document.createTextNode(account.name)); }
  drawOwnAvatar();
  const options = $('div', profile);
  const avatarFile = document.createElement('input');
  avatarFile.type = 'file';
  avatarFile.hidden = true;
  avatarFile.accept = 'image/png,image/jpeg,image/webp,image/gif';
  const resetAvatar = button('Minecraft-Kopf verwenden', () => saveAvatar(null));
  resetAvatar.hidden = true;
  async function saveAvatar(value) {
    try {
      account.avatar = await api.invoke('friends:avatar', value);
      resetAvatar.hidden = !account.avatar;
      drawOwnAvatar();
      toast(value ? 'Profilbild gespeichert.' : 'Minecraft-Kopf ausgewählt.');
    } catch (err) { toast(errText(err), true); }
  }
  avatarFile.onchange = async () => {
    const file = avatarFile.files[0];
    avatarFile.value = '';
    if (!file || $('#cropDlg').open) return;
    const url = URL.createObjectURL(file);
    try {
      const cropped = await cropImage(url, false, true);
      if (cropped && panel.isConnected) await saveAvatar(cropped);
    } catch { toast('Das Profilbild konnte nicht geöffnet werden.', true); }
    finally { URL.revokeObjectURL(url); }
  };
  options.append(avatarFile, button('Profilbild ändern', () => avatarFile.click()), resetAvatar);
  api.invoke('friends:appearance').then((data) => {
    if (!panel.isConnected || account.avatar) return;
    account.avatar = data?.avatar;
    resetAvatar.hidden = !account.avatar;
    drawOwnAvatar();
  }).catch(() => {});
  options.append(button('Freundescode kopieren', () => act('copyCode', undefined, 'Freundescode kopiert.', false)));
  const changePresence = async (key, value) => {
    try {
      await setS({ [key]: value });
      await api.invoke('friends:presence');
    } catch (err) { toast(errText(err), true); }
  };
  const prefs = document.createElement('div');
  prefs.className = 'message-preferences';
  let packSwitch;
  for (const [text, hint, on, update] of [
    ['Ton', 'Bei neuen Nachrichten und Anfragen', S.friendsSound !== false, (v) => setS({ friendsSound: v })],
    ['Pop-up', 'Benachrichtigungen anzeigen', S.friendsPopup !== false, (v) => setS({ friendsPopup: v })],
    ['Online anzeigen', 'Nur für bestätigte Freunde', S.friendsOnline === true, (v) => changePresence('friendsOnline', v)],
    ['Modpack im Status', 'Bei sichtbarem Online-Status', S.friendsPlaying === true, (v) => changePresence('friendsPlaying', v)],
  ]) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = on;
    input.setAttribute('role', 'switch');
    const textWrap = document.createElement('span');
    const name = document.createElement('strong'), description = document.createElement('small');
    name.textContent = text;
    description.textContent = hint;
    textWrap.append(name, description);
    const pill = document.createElement('span');
    pill.className = 'message-toggle';
    pill.setAttribute('aria-hidden', 'true');
    input.onchange = async () => {
      input.disabled = true;
      try { await update(input.checked); }
      catch { input.checked = !input.checked; }
      finally {
        input.disabled = false;
        packSwitch.disabled = S.friendsOnline !== true;
      }
    };
    if (text === 'Modpack im Status') { packSwitch = input; input.disabled = S.friendsOnline !== true; }
    label.append(input, textWrap, pill);
    prefs.append(label);
  }
  options.append(prefs, button('Abmelden', () => act('logout')));

  let rows = [], groups = [], groupsError = '', working = false, refreshing = false, again = false;
  function emptyConversation() {
    body.classList.remove('has-chat');
    activeFriendChat = undefined;
    const hint = document.createElement('p');
    hint.className = 'message-empty';
    hint.textContent = friendShareInstance ? 'Wähle einen Freund, um die Instanz zu teilen.' : 'Wähle einen Chat aus.';
    stage.replaceChildren(hint);
  }
  emptyConversation();

  async function change(channel, data, feedback) {
    if (working) return;
    working = true;
    status.classList.remove('err');
    try {
      await api.invoke('friends:' + channel, data);
      status.textContent = feedback || '';
      await refresh();
    } catch (err) {
      status.textContent = errText(err);
      status.classList.add('err');
    } finally { working = false; }
  }

  $('.message-add', body).onclick = async () => {
    if (friendsPane === 'groups') {
      showGroupDialog(null, rows, (group) => {
        groups.push(group);
        refresh();
        openChat(group);
      });
      return;
    }
    const code = await ask({ title: 'Freund hinzufügen', text: 'Gib den MSF-Freundescode ein.', input: '', okText: 'Anfrage senden' });
    if (typeof code === 'string' && code.trim()) change('invite', code, 'Freundschaftsanfrage gesendet.');
  };
  for (const item of body.querySelectorAll('.message-tabs button')) item.onclick = () => {
    friendsPane = item.dataset.pane;
    draw();
  };
  search.oninput = () => draw();

  function openChat(entry) {
    if (entry.id === activeFriendChat?.entry.id) { activeFriendChat.refresh(); return; }
    const goBack = () => { emptyConversation(); draw(); };
    const leaveOrRemove = async () => {
      if (entry.group) {
        if (await ask({ title: 'Gruppe verlassen?', text: entry.name, okText: 'Verlassen', danger: true })) {
          await change('groups:remove', { id: entry.id, uid: account.uid });
        }
      } else if (await ask({ title: 'Freund entfernen?', text: entry.name, okText: 'Entfernen', danger: true })) {
        await change('respond', { id: entry.id, accept: false });
      }
    };
    openFriendChat(entry, stage, goBack, leaveOrRemove, () => showGroupDialog(entry, rows, refresh));
    body.classList.add('has-chat');
    draw();
  }

  function draw() {
    if (!panel.isConnected) return;
    for (const item of body.querySelectorAll('.message-tabs button')) {
      item.setAttribute('aria-pressed', String(item.dataset.pane === friendsPane));
      if (item.dataset.pane === 'requests') item.textContent = friendRequestCount ? `Anfragen (${friendRequestCount})` : 'Anfragen';
      if (item.dataset.pane === 'groups') item.textContent = groupInviteCount ? `Gruppen (${groupInviteCount})` : 'Gruppen';
    }
    const adding = friendsPane === 'groups' ? 'Gruppe erstellen' : 'Freund hinzufügen';
    $('.message-add', body).title = adding;
    $('.message-add', body).setAttribute('aria-label', adding);
    search.placeholder = friendsPane === 'groups' ? 'Gruppen suchen …' : 'Freunde suchen …';
    search.setAttribute('aria-label', search.placeholder);
    list.replaceChildren();
    const query = search.value.trim().toLocaleLowerCase('de');
    const source = friendsPane === 'groups' ? groups : rows.filter((row) => row.accepted === (friendsPane === 'chats'));
    const filtered = source.filter((row) => row.name.toLocaleLowerCase('de').includes(query));
    if (!filtered.length) {
      const hint = document.createElement('p');
      hint.className = 'message-list-empty';
      hint.textContent = query ? 'Keine Treffer.' : friendsPane === 'groups'
        ? groupsError || 'Noch keine Gruppen.' : friendsPane === 'requests' ? 'Keine offenen Anfragen.' : 'Noch keine Unterhaltungen.';
      list.append(hint);
    }
    for (const entry of filtered) {
      const name = document.createElement('strong');
      name.textContent = entry.name;
      if (entry.accepted || entry.state === 'member') {
        const contact = button('', () => openChat(entry));
        contact.className = 'message-contact';
        contact.dataset.chat = entry.id;
        contact.classList.toggle('chat-unread', unreadFriendChats.has(entry.id));
        contact.setAttribute('aria-label', entry.name + (unreadFriendChats.has(entry.id) ? ' · ungelesen' : ''));
        contact.setAttribute('aria-current', String(entry.id === activeFriendChat?.entry.id));
        const labels = document.createElement('span');
        labels.className = 'message-contact-labels';
        labels.append(name);
        const presence = friendActivity(entry);
        if (presence) {
          const line = document.createElement('small');
          line.className = 'friend-activity';
          line.textContent = presence;
          labels.append(line);
        }
        contact.append(friendAvatar(entry), labels);
        list.append(contact);
      } else {
        const row = document.createElement('article');
        row.className = 'message-request';
        const title = document.createElement('div');
        const hint = document.createElement('small');
        hint.textContent = entry.group ? 'Gruppeneinladung' : entry.incoming ? 'Möchte dich hinzufügen' : 'Anfrage gesendet';
        title.append(name, hint);
        row.append(friendAvatar(entry), title);
        const respond = (accept) => change(entry.group ? 'groups:respond' : 'respond', { id: entry.id, accept });
        if (entry.group || entry.incoming) row.append(button('Annehmen', () => respond(true), true));
        row.append(button(entry.group || entry.incoming ? 'Ablehnen' : 'Zurückziehen', () => respond(false)));
        list.append(row);
      }
    }
  }

  async function refresh() {
    if (!panel.isConnected) return;
    if (refreshing) { again = true; return; }
    refreshing = true;
    try {
      const [friendsResult, groupsResult] = await Promise.allSettled([api.invoke('friends:list'), api.invoke('friends:groups:list')]);
      if (!panel.isConnected) return;
      if (friendsResult.status === 'fulfilled') rows = friendsResult.value;
      if (groupsResult.status === 'fulfilled') { groups = groupsResult.value; groupsError = ''; }
      else groupsError = errText(groupsResult.reason);
      friendRequestCount = rows.filter((row) => !row.accepted && row.incoming).length;
      groupInviteCount = groups.filter((row) => row.state === 'invited').length;
      const unread = await api.invoke('friends:unread');
      if (!panel.isConnected) return;
      markUnreadFriendChats(unread);
      if (activeFriendChat) {
        const current = activeFriendChat.entry.group
          ? groups.find((row) => row.state === 'member' && row.id === activeFriendChat.entry.id)
          : rows.find((row) => row.accepted && row.id === activeFriendChat.entry.id);
        if (current) activeFriendChat.updateContact(current);
        else emptyConversation();
      }
      draw();
    } catch (err) {
      status.textContent = errText(err);
      status.classList.add('err');
    } finally {
      refreshing = false;
      if (again) { again = false; refresh(); }
    }
  }
  if (friendShareInstance) friendsPane = 'chats';
  status.textContent = notice;
  messenger = { panel, draw, refresh };
  draw();
  refresh();
  const activityTimer = setInterval(() => {
    if (!panel.isConnected) clearInterval(activityTimer);
    else if (!document.hidden) refresh();
  }, 15000);
}

function showGroupDialog(group, friends, onChange) {
  if (document.querySelector('dialog[open]')) return;
  const dlg = document.createElement('dialog');
  dlg.className = 'group-dialog';
  dlg.innerHTML = `
    <form>
      <div class="dh" id="group-dialog-title"></div>
      <div class="db">
        <label class="group-name">Gruppenname<input name="name" maxlength="48" required></label>
        <div class="group-members"></div>
        <div class="group-invite"><b>Freunde einladen</b><div class="group-options"></div></div>
        <p class="group-feedback" role="status"></p>
      </div>
      <div class="df"><button type="button" class="ghost">Schließen</button><button type="submit" class="primary"></button></div>
    </form>`;
  dlg.setAttribute('aria-labelledby', 'group-dialog-title');
  $('.dh', dlg).textContent = group ? 'Mitglieder · ' + group.name : 'Gruppe erstellen';
  const form = $('form', dlg);
  const name = form.elements.name;
  name.required = !group;
  name.disabled = !!group;
  $('.group-name', dlg).hidden = !!group;
  const list = $('.group-members', dlg), choices = $('.group-options', dlg), feedback = $('.group-feedback', dlg);
  const primary = $('button[type=submit]', dlg);
  $('.group-invite', dlg).hidden = !!group && !group.owner;
  primary.hidden = !!group && !group.owner;
  primary.textContent = group ? 'Einladen' : 'Gruppe erstellen';
  primary.disabled = !!group;
  $('button[type=button]', dlg).onclick = () => dlg.close();
  dlg.addEventListener('close', () => dlg.remove(), { once: true });
  let pending = false;

  function draw(members) {
    list.replaceChildren();
    const inGroup = new Set(members.map(({ uid }) => uid));
    for (const member of members) {
      const row = document.createElement('div');
      row.className = 'group-member';
      const label = document.createElement('span');
      const role = member.owner ? 'Leitung' : member.state === 'invited' ? 'Eingeladen' : '';
      label.textContent = member.name + (member.self ? ' (du)' : '') + (role ? ' · ' + role : '');
      row.append(label);
      if (group.owner && !member.owner) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'ghost';
        remove.textContent = member.state === 'invited' ? 'Zurückziehen' : 'Entfernen';
        remove.onclick = async () => {
          if (pending || !await ask({ title: member.state === 'invited' ? 'Einladung zurückziehen?' : 'Mitglied entfernen?',
            text: member.name, okText: remove.textContent, danger: true })) return;
          pending = remove.disabled = true;
          try {
            await api.invoke('friends:groups:remove', { id: group.id, uid: member.uid });
            await refreshMembers();
            onChange();
          } catch (err) { feedback.textContent = errText(err); }
          finally { pending = remove.disabled = false; }
        };
        row.append(remove);
      }
      list.append(row);
    }
    choices.replaceChildren();
    if (group && !group.owner) return;
    for (const friend of friends.filter((entry) => entry.accepted && !inGroup.has(entry.uid))) {
      const label = document.createElement('label');
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.name = 'friend';
      check.value = friend.uid;
      check.onchange = () => { if (group) primary.disabled = !new FormData(form).getAll('friend').length; };
      const portrait = document.createElement('span');
      portrait.className = 'group-portrait';
      const mark = document.createElement('span');
      mark.className = 'group-picked';
      mark.setAttribute('aria-hidden', 'true');
      mark.textContent = '✓';
      portrait.append(friendAvatar(friend), mark);
      const username = document.createElement('span');
      username.className = 'group-friend-name';
      username.textContent = label.title = friend.name;
      label.append(check, portrait, username);
      choices.append(label);
    }
    if (!choices.children.length) choices.textContent = 'Keine weiteren bestätigten Freunde verfügbar.';
    primary.disabled = !!group;
  }

  async function refreshMembers() {
    try { draw(await api.invoke('friends:groups:members', group.id)); }
    catch (err) { feedback.textContent = errText(err); }
  }

  form.onsubmit = async (event) => {
    event.preventDefault();
    if (pending || (group && !group.owner)) return;
    pending = primary.disabled = true;
    const selected = new FormData(form).getAll('friend');
    try {
      const result = await api.invoke(group ? 'friends:groups:invite' : 'friends:groups:create',
        group ? { id: group.id, friends: selected } : { name: name.value, friends: selected });
      if (group) {
        await refreshMembers();
        feedback.textContent = 'Einladungen gesendet.';
        onChange();
      } else {
        dlg.close();
        onChange(result);
      }
    } catch (err) {
      feedback.textContent = errText(err);
      primary.disabled = false;
    } finally { pending = false; }
  };
  document.body.append(dlg);
  if (group) refreshMembers();
  else draw([]);
  dlg.showModal();
}

function openFriendChat(entry, stage, back, remove, membersDialog) {
  const selectedInstance = friendShareInstance;
  friendShareInstance = undefined;
  const panel = document.createElement('section');
  panel.className = 'friend-chat';
  panel.innerHTML = `
    <header><button type="button" class="ghost chat-back" aria-label="Zur Chatliste">‹</button><div class="chat-person"><h2></h2><small class="friend-activity" hidden></small></div><button type="button" class="ghost chat-members" hidden>Mitglieder</button><details class="chat-menu"><summary aria-label="Chat-Optionen">⋯</summary><button type="button" class="ghost chat-remove">Freund entfernen</button></details></header>
    <nav class="message-tabs chat-history-tabs" aria-label="Unterhaltung"><button type="button" aria-pressed="true">Chat</button><button type="button" aria-pressed="false">Geteilt</button></nav>
    <p class="friends-status chat-status" role="status"></p>
    <div class="chat-scroll" aria-label="Nachrichten" tabindex="0"></div>
    <div class="chat-scroll shared-packs" aria-label="Geteilte Modpacks" hidden></div>
    <footer>
      <form class="chat-share" hidden>
        <div><select name="instance" aria-label="Instanz zum Teilen" required><option value="">Instanz auswählen …</option></select>
        <select name="method" aria-label="Einladungsart"><option value="">Modpack teilen</option><option value="essential">Über Essential einladen</option><option value="server">Zu Server einladen</option></select></div>
        <input name="address" placeholder="Serveradresse[:Port]" aria-label="Serveradresse" maxlength="120" hidden disabled>
        <small hidden>Hoste die Welt in Essential und lade deinen Freund dort ein. Diese Karte teilt das passende Modpack.</small>
        <button type="submit" class="ghost">Senden</button>
      </form>
      <form class="chat-compose">
        <button type="button" class="ghost chat-attach" title="Modpack anhängen" aria-label="Modpack anhängen" aria-expanded="false">+</button>
        <textarea rows="1" maxlength="2000" placeholder="Nachricht schreiben …" aria-label="Nachricht" required></textarea>
        <button type="submit" class="primary">Senden</button>
      </form>
    </footer>`;
  stage.replaceChildren(panel);
  let shownPerson;
  function updateContact(contact) {
    const signature = contact.name + '\n' + (contact.avatar || '') + '\n' + friendActivity(contact);
    if (signature === shownPerson) return;
    shownPerson = signature;
    $('h2', panel).textContent = contact.name;
    const activity = $('.friend-activity', panel);
    activity.textContent = friendActivity(contact);
    activity.hidden = !activity.textContent;
    const person = $('.chat-person', panel);
    const current = $('header > .message-avatar', panel);
    if (current) current.replaceWith(friendAvatar(contact));
    else person.before(friendAvatar(contact));
  }
  updateContact(entry);
  const status = $('.friends-status', panel), messages = $('.chat-scroll', panel);
  const composer = $('.chat-compose', panel), text = $('textarea', composer);
  const share = $('.chat-share', panel), instances = share.elements.instance;
  const method = share.elements.method;
  const address = share.elements.address;
  const channel = (name) => 'friends:' + (entry.group ? 'groups:' : '') + name;
  const authors = new Map();
  let membersLoaded = false;
  async function loadAuthors() {
    const rows = await api.invoke('friends:groups:members', entry.id);
    for (const person of rows) authors.set(person.uid, person.name);
    membersLoaded = true;
  }
  if (entry.group) {
    method.hidden = method.disabled = true;
    const members = $('.chat-members', panel);
    members.hidden = false;
    members.onclick = membersDialog;
    if (entry.owner) $('.chat-menu', panel).hidden = true;
    else $('.chat-remove', panel).textContent = 'Gruppe verlassen';
  }
  method.onchange = () => {
    address.hidden = address.disabled = method.value !== 'server';
    address.required = !address.disabled;
    $('small', share).hidden = method.value !== 'essential';
    $('button[type=submit]', share).textContent = method.value ? 'Einladung senden' : 'Modpack senden';
  };
  method.onchange();
  const attach = $('.chat-attach', panel);
  attach.onclick = () => {
    share.hidden = !share.hidden;
    attach.setAttribute('aria-expanded', String(!share.hidden));
    if (!share.hidden) instances.focus();
  };
  for (const instance of insts) {
    const option = new Option(instance.name, instance.id);
    instances.add(option);
    if (instance.id === selectedInstance) instances.value = instance.id;
  }
  attach.disabled = !insts.length;
  if (instances.value) { share.hidden = false; attach.setAttribute('aria-expanded', 'true'); }
  let reading = false, readAgain = false, sending = false, rendered = '';
  const isOpen = () => panel.isConnected && view === 'friends';
  const time = new Intl.DateTimeFormat('de-DE', { timeStyle: 'short' });
  const date = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium' });
  const sharedView = $('.shared-packs', panel), footer = $('footer', panel);
  const [chatTab, sharedTab] = panel.querySelectorAll('.chat-history-tabs button');
  const shared = new Map();
  let before, loadedShared = false, loadingShared = false;

  function renderPack(bubble, row) {
    const title = document.createElement('strong');
    title.textContent = (row.invite?.method === 'essential' ? 'Essential-Einladung' : row.invite?.method === 'server' ? 'Server-Einladung' : 'Modpack') + ' · ' + row.title;
    bubble.append(title);
    if (row.invite) {
      const instructions = document.createElement('small');
      if (row.invite.method === 'essential') {
        instructions.textContent = row.mine ? 'Sende die Welteinladung im Spiel über Essential.' : 'Host: ' + row.invite.host + ' · Essential → Social → Join Game';
      } else instructions.textContent = row.invite.address;
      bubble.append(instructions);
      const target = row.invite.method === 'server' ? row.invite.address :
        row.mine && /^[A-Za-z0-9_]{3,16}$/.test(entry.name) ? '/einvite ' + entry.name : row.invite.host;
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'ghost';
      copy.textContent = row.invite.method === 'server' ? 'Serveradresse kopieren' : target.startsWith('/') ? 'Essential-Befehl kopieren' : 'Minecraft-Namen kopieren';
      copy.onclick = () => navigator.clipboard.writeText(target).then(() => toast('Kopiert.')).catch((err) => toast(errText(err), true));
      bubble.append(copy);
    }
    if (row.skipped > 0) {
      const note = document.createElement('small');
      note.textContent = `${row.skipped} lokale Einträge fehlen.`;
      bubble.append(note);
    }
    if (!row.mine) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ghost';
      button.textContent = 'Als Instanz importieren';
      button.onclick = async () => {
        if (busy || !await ask({ title: 'Modpack importieren?', text: `„${row.title}“ wird als neue Instanz angelegt.`, okText: 'Importieren' })) return;
        await cfRun('share:importCode', row.content);
      };
      bubble.append(button);
    }
  }

  function drawShared() {
    const scrollTop = sharedView.scrollTop;
    sharedView.replaceChildren();
    const packs = [...shared.values()].sort((a, b) => b.at - a.at);
    if (!packs.length && loadedShared) {
      const hint = document.createElement('p');
      hint.textContent = before ? 'Auf dieser Seite sind keine Modpacks.' : 'Hier wurden noch keine Modpacks geteilt.';
      sharedView.append(hint);
    }
    for (const pack of packs) {
      const card = document.createElement('article');
      card.className = 'chat-message pack shared-pack';
      renderPack(card, pack);
      const sent = document.createElement('time');
      sent.textContent = date.format(pack.at);
      card.append(sent);
      sharedView.append(card);
    }
    if (before) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'ghost';
      more.textContent = 'Ältere Nachrichten durchsuchen';
      more.onclick = loadShared;
      sharedView.append(more);
    }
    sharedView.scrollTop = scrollTop;
  }

  async function loadShared() {
    if (loadingShared || !isOpen()) return;
    loadingShared = true;
    try {
      const page = await api.invoke(channel('shared'), { id: entry.id, before });
      if (!isOpen()) return;
      if (before && page.before === before) return;
      before = page.before;
      loadedShared = true;
      for (const pack of page.packs) shared.set(pack.messageId, pack);
      drawShared();
    } catch (err) { toast(errText(err), true); }
    finally { loadingShared = false; }
  }

  function showShared(show) {
    chatTab.setAttribute('aria-pressed', String(!show));
    sharedTab.setAttribute('aria-pressed', String(show));
    messages.hidden = footer.hidden = show;
    sharedView.hidden = !show;
    if (show && !loadedShared) loadShared();
  }
  chatTab.onclick = () => showShared(false);
  sharedTab.onclick = () => showShared(true);

  function paint(rows) {
    const ids = rows.map((row) => row.messageId).join(',');
    if (ids === rendered && messages.childNodes.length) return;
    const scrollTop = messages.scrollTop;
    const atBottom = !messages.childNodes.length || messages.scrollHeight - scrollTop - messages.clientHeight < 60;
    rendered = ids;
    messages.replaceChildren();
    if (!rows.length) {
      const empty = document.createElement('p');
      empty.textContent = 'Hier könnt ihr Nachrichten und Modpacks austauschen.';
      messages.append(empty);
    }
    let lastDay;
    for (const row of rows) {
      const day = date.format(row.at);
      if (day !== lastDay) {
        const divider = document.createElement('div');
        divider.className = 'chat-day';
        divider.textContent = day;
        messages.append(divider);
        lastDay = day;
      }
      const bubble = document.createElement('article');
      bubble.className = 'chat-message' + (row.mine ? ' mine' : '') + (['pack', 'sync'].includes(row.kind) ? ' pack' : '');
      if (entry.group && !row.mine) {
        const author = document.createElement('small');
        author.className = 'chat-author';
        author.textContent = authors.get(row.from) || 'Früheres Mitglied';
        bubble.append(author);
      }
      if (row.kind === 'pack') {
        renderPack(bubble, row);
        if (loadedShared) shared.set(row.messageId, row);
      } else if (row.kind === 'sync') renderSharedSyncCard(bubble, row, entry.id);
      else bubble.append(document.createTextNode(row.content));
      const sent = document.createElement('time');
      sent.textContent = time.format(row.at);
      bubble.append(sent);
      messages.append(bubble);
    }
    messages.scrollTop = atBottom ? messages.scrollHeight : scrollTop;
    if (loadedShared && !sharedView.hidden) drawShared();
  }

  async function refresh() {
    if (!isOpen()) return;
    if (reading) { readAgain = true; return; }
    reading = true;
    try {
      const rows = await api.invoke(channel('chat'), entry.id);
      if (entry.group && (!membersLoaded || rows.some((row) => !row.mine && !authors.has(row.from)))) {
        await loadAuthors().catch(() => {});
        for (const row of rows) if (!authors.has(row.from)) authors.set(row.from, 'Früheres Mitglied');
      }
      if (!isOpen()) return;
      paint(rows);
      if (status.dataset.readError) {
        status.textContent = '';
        status.classList.remove('err');
      }
      delete status.dataset.readError;
      const last = rows.findLast((row) => !row.mine);
      if (last && document.hasFocus()) {
        const unread = await api.invoke('friends:readChat', { id: entry.id, messageId: last.messageId, at: last.at });
        if (isOpen()) markUnreadFriendChats(unread);
      }
    } catch (error) {
      if (!isOpen()) return;
      status.textContent = errText(error);
      status.classList.add('err');
      status.dataset.readError = 'true';
    } finally {
      reading = false;
      if (readAgain) { readAgain = false; refresh(); }
    }
  }

  async function send(channel, form, data, confirm) {
    if (sending) return false;
    sending = true;
    delete status.dataset.readError;
    status.classList.remove('err');
    status.textContent = '';
    const button = $('button[type="submit"]', form);
    button.disabled = true;
    try {
      if (confirm && !await confirm()) return false;
      await api.invoke(channel, { id: entry.id, ...data });
      await refresh();
      return true;
    } catch (error) {
      status.textContent = errText(error);
      status.classList.add('err');
      return false;
    } finally { sending = false; button.disabled = false; }
  }

  $('.chat-back', panel).onclick = back;
  $('.chat-remove', panel).onclick = remove;
  text.onkeydown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); composer.requestSubmit(); }
  };
  composer.onsubmit = async (event) => {
    event.preventDefault();
    const message = text.value;
    if (await send(channel('sendText'), composer, { text: message }) && text.value === message) text.value = '';
  };
  share.onsubmit = async (event) => {
    event.preventDefault();
    const instanceId = instances.value;
    const inviteMethod = method.value;
    const sent = await send(channel('sendPack'), share, { instanceId, method: inviteMethod, address: address.value }, async () => {
      const { skipped, name } = await api.invoke('share:code', instanceId);
      const note = skipped.length ? ` ${skipped.length} lokale Einträge sind nur im .mrpack-Export enthalten.` : '';
      return ask({ title: inviteMethod ? 'Spieleinladung senden?' : 'Modpack senden?', text: `„${name}“ an ${entry.name} senden?${note}`, okText: 'Senden' });
    });
    if (sent) { share.hidden = true; attach.setAttribute('aria-expanded', 'false'); }
  };
  activeFriendChat = { entry, panel, refresh, updateContact };
  refresh();
}
