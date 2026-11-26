let activeFriendChat, friendShareInstance, messenger;
let friendsPane = 'chats', friendRequestCount = 0;
let unreadFriendChats = new Set();

function markUnreadFriendChats(ids) {
  unreadFriendChats = new Set(ids);
  const rail = $('[data-v="friends"]');
  let badge = $('.rbadge', rail);
  const count = ids.length + friendRequestCount;
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
      if (event.showRequests) friendsPane = 'requests';
      setView('friends');
      if (event.showRequests) messenger?.draw();
      return;
    }
    friendRequestCount = event.requests.length;
    markUnreadFriendChats(event.unread);
    if (event.sound) {
      chime.currentTime = 0;
      chime.play().catch(() => {});
    }
    if (event.toast && (event.requested || event.arrived.some(({ id }) => id !== activeFriendChat?.entry.id))) toast(event.toast);
    if (event.arrived.some(({ id }) => id === activeFriendChat?.entry.id)) activeFriendChat.refresh();
    if (event.contactsChanged && messenger?.panel.isConnected) messenger.refresh();
  });
  window.addEventListener('focus', () => activeFriendChat?.refresh());
  api.invoke('friends:friendState').then(({ unread, requests }) => {
    friendRequestCount = requests.length;
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

function friendAvatar(name) {
  const avatar = document.createElement('span');
  avatar.className = 'message-avatar';
  avatar.textContent = Array.from(name.trim())[0]?.toUpperCase() || '?';
  avatar.setAttribute('aria-hidden', 'true');
  return avatar;
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
      <nav class="message-tabs" aria-label="Freunde"><button type="button" data-pane="chats">Chats</button><button type="button" data-pane="requests">Anfragen</button></nav>
      <div class="message-contacts"></div>
      <details class="message-profile"><summary></summary><div></div></details>
    </aside>
    <div class="message-conversation"></div>`;
  const status = $('.friends-status', panel);
  const list = $('.message-contacts', body), stage = $('.message-conversation', body), search = $('.message-search', body);
  const profile = $('.message-profile', body);
  $('summary', profile).append(friendAvatar(account.name), document.createTextNode(account.name));
  const options = $('div', profile);
  options.append(button('Freundescode kopieren', () => act('copyCode', undefined, 'Freundescode kopiert.', false)));
  options.append(toggles([
    ['Ton', 'Nachrichten und Anfragen', S.friendsSound !== false, (v) => setS({ friendsSound: v })],
    ['Pop-up', 'Nachrichten und Anfragen', S.friendsPopup !== false, (v) => setS({ friendsPopup: v })],
  ]), button('Abmelden', () => act('logout')));

  let rows = [], working = false, refreshing = false, again = false;
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
    const code = await ask({ title: 'Freund hinzufügen', text: 'Gib den MSF-Freundescode ein.', input: '', okText: 'Anfrage senden' });
    if (typeof code === 'string' && code.trim()) change('invite', code, 'Freundschaftsanfrage gesendet.');
  };
  for (const item of body.querySelectorAll('.message-tabs button')) item.onclick = () => {
    friendsPane = item.dataset.pane;
    draw();
  };
  search.oninput = () => draw();

  function draw() {
    if (!panel.isConnected) return;
    for (const item of body.querySelectorAll('.message-tabs button')) {
      item.setAttribute('aria-pressed', String(item.dataset.pane === friendsPane));
      if (item.dataset.pane === 'requests') item.textContent = friendRequestCount ? `Anfragen (${friendRequestCount})` : 'Anfragen';
    }
    list.replaceChildren();
    const query = search.value.trim().toLocaleLowerCase('de');
    const filtered = rows.filter((row) => row.accepted === (friendsPane === 'chats') && row.name.toLocaleLowerCase('de').includes(query));
    if (!filtered.length) {
      const hint = document.createElement('p');
      hint.className = 'message-list-empty';
      hint.textContent = query ? 'Keine Treffer.' : friendsPane === 'requests' ? 'Keine offenen Anfragen.' : 'Noch keine Unterhaltungen.';
      list.append(hint);
    }
    for (const entry of filtered) {
      const name = document.createElement('strong');
      name.textContent = entry.name;
      if (entry.accepted) {
        const contact = button('', () => {
          if (entry.id === activeFriendChat?.entry.id) { activeFriendChat.refresh(); return; }
          openFriendChat(entry, stage, () => { emptyConversation(); draw(); }, async () => {
            if (await ask({ title: 'Freund entfernen?', text: entry.name, okText: 'Entfernen', danger: true })) {
              await change('respond', { id: entry.id, accept: false });
            }
          });
          body.classList.add('has-chat');
          draw();
        });
        contact.className = 'message-contact';
        contact.dataset.chat = entry.id;
        contact.classList.toggle('chat-unread', unreadFriendChats.has(entry.id));
        contact.setAttribute('aria-label', entry.name + (unreadFriendChats.has(entry.id) ? ' · ungelesen' : ''));
        contact.setAttribute('aria-current', String(entry.id === activeFriendChat?.entry.id));
        contact.append(friendAvatar(entry.name), name);
        list.append(contact);
      } else {
        const row = document.createElement('article');
        row.className = 'message-request';
        const title = document.createElement('div');
        const hint = document.createElement('small');
        hint.textContent = entry.incoming ? 'Möchte dich hinzufügen' : 'Anfrage gesendet';
        title.append(name, hint);
        row.append(friendAvatar(entry.name), title);
        const respond = (accept) => change('respond', { id: entry.id, accept });
        if (entry.incoming) row.append(button('Annehmen', () => respond(true), true));
        row.append(button(entry.incoming ? 'Ablehnen' : 'Zurückziehen', () => respond(false)));
        list.append(row);
      }
    }
  }

  async function refresh() {
    if (!panel.isConnected) return;
    if (refreshing) { again = true; return; }
    refreshing = true;
    try {
      const incoming = await api.invoke('friends:list');
      if (!panel.isConnected) return;
      rows = incoming;
      friendRequestCount = rows.filter((row) => !row.accepted && row.incoming).length;
      const unread = await api.invoke('friends:unread');
      if (!panel.isConnected) return;
      markUnreadFriendChats(unread);
      if (activeFriendChat && !rows.some((row) => row.accepted && row.id === activeFriendChat.entry.id)) emptyConversation();
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
}

function openFriendChat(entry, stage, back, remove) {
  const selectedInstance = friendShareInstance;
  friendShareInstance = undefined;
  const panel = document.createElement('section');
  panel.className = 'friend-chat';
  panel.innerHTML = `
    <header><button type="button" class="ghost chat-back" aria-label="Zur Chatliste">‹</button><h2></h2><details class="chat-menu"><summary aria-label="Chat-Optionen">⋯</summary><button type="button" class="ghost chat-remove">Freund entfernen</button></details></header>
    <p class="friends-status chat-status" role="status"></p>
    <div class="chat-scroll" aria-label="Nachrichten" tabindex="0"></div>
    <footer>
      <form class="chat-share" hidden>
        <select aria-label="Instanz zum Teilen" required><option value="">Instanz auswählen …</option></select>
        <button type="submit" class="ghost">Modpack senden</button>
      </form>
      <form class="chat-compose">
        <button type="button" class="ghost chat-attach" title="Modpack anhängen" aria-label="Modpack anhängen" aria-expanded="false">+</button>
        <textarea rows="1" maxlength="2000" placeholder="Nachricht schreiben …" aria-label="Nachricht" required></textarea>
        <button type="submit" class="primary">Senden</button>
      </form>
    </footer>`;
  stage.replaceChildren(panel);
  $('h2', panel).textContent = entry.name;
  $('h2', panel).before(friendAvatar(entry.name));
  const status = $('.friends-status', panel), messages = $('.chat-scroll', panel);
  const composer = $('.chat-compose', panel), text = $('textarea', composer);
  const share = $('.chat-share', panel), instances = $('select', share);
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
      bubble.className = 'chat-message' + (row.mine ? ' mine' : '') + (row.kind === 'pack' ? ' pack' : '');
      const content = document.createElement(row.kind === 'pack' ? 'strong' : 'div');
      content.textContent = row.kind === 'pack' ? 'Modpack · ' + row.title : row.content;
      bubble.append(content);
      if (row.kind === 'pack' && row.skipped > 0) {
        const note = document.createElement('small');
        note.textContent = `${row.skipped} lokale Einträge fehlen.`;
        bubble.append(note);
      }
      if (row.kind === 'pack' && !row.mine) {
        const importButton = document.createElement('button');
        importButton.type = 'button';
        importButton.className = 'ghost';
        importButton.textContent = 'Als Instanz importieren';
        importButton.onclick = async () => {
          if (busy || !await ask({ title: 'Modpack importieren?', text: `„${row.title}“ wird als neue Instanz angelegt.`, okText: 'Importieren' })) return;
          await cfRun('share:importCode', row.content);
        };
        bubble.append(importButton);
      }
      const sent = document.createElement('time');
      sent.textContent = time.format(row.at);
      bubble.append(sent);
      messages.append(bubble);
    }
    messages.scrollTop = atBottom ? messages.scrollHeight : scrollTop;
  }

  async function refresh() {
    if (!isOpen()) return;
    if (reading) { readAgain = true; return; }
    reading = true;
    try {
      const rows = await api.invoke('friends:chat', entry.id);
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
    if (await send('friends:sendText', composer, { text: message }) && text.value === message) text.value = '';
  };
  share.onsubmit = async (event) => {
    event.preventDefault();
    const instanceId = instances.value;
    const sent = await send('friends:sendPack', share, { instanceId }, async () => {
      const { skipped, name } = await api.invoke('share:code', instanceId);
      const note = skipped.length ? ` ${skipped.length} lokale Einträge sind nur im .mrpack-Export enthalten.` : '';
      return ask({ title: 'Modpack senden?', text: `„${name}“ an ${entry.name} senden?${note}`, okText: 'Senden' });
    });
    if (sent) { share.hidden = true; attach.setAttribute('aria-expanded', 'false'); }
  };
  activeFriendChat = { entry, panel, refresh };
  refresh();
}
