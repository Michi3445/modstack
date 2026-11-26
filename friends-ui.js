let activeFriendChat, friendShareInstance;
let unreadFriendChats = new Set();

function markUnreadFriendChats(ids) {
  unreadFriendChats = new Set(ids);
  const rail = $('[data-v="friends"]');
  let badge = $('.rbadge', rail);
  if (ids.length) {
    if (!badge) { badge = document.createElement('i'); badge.className = 'rbadge'; rail.append(badge); }
    badge.textContent = ids.length > 99 ? '99+' : ids.length;
  } else badge?.remove();
  for (const button of document.querySelectorAll('button[data-chat]')) {
    button.textContent = unreadFriendChats.has(button.dataset.chat) ? 'Chat · Neu' : 'Chat';
  }
}

function startFriendNotifications() {
  api.onFriendChat((event) => {
    if (event.open) { setView('friends'); return; }
    markUnreadFriendChats(event.unread);
    if (event.toast) toast(event.toast);
    if (event.arrived.some(({ id }) => id === activeFriendChat?.entry.id)) activeFriendChat.refresh();
  });
  window.addEventListener('focus', () => activeFriendChat?.refresh());
  api.invoke('friends:unread').then(markUnreadFriendChats).catch(() => {});
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

    const form = showForm(`
      <h2></h2><label>Dein Freundescode<input name="ownCode" readonly></label>
      <label>Freundescode eingeben<input name="code" placeholder="MSF-…" maxlength="132" spellcheck="false" required></label>
      <button class="primary">Anfrage senden</button>`, ({ code }) => act('invite', code, 'Freundschaftsanfrage gesendet.'));
    $('h2', form).textContent = state.name;
    const ownCode = form.elements.ownCode;
    ownCode.value = 'MSF-' + state.uid;
    ownCode.onclick = () => ownCode.select();
    ownCode.parentElement.after(button('Code kopieren', () => act('copyCode', undefined, 'Freundescode kopiert.', false)));
    const actions = document.createElement('div');
    actions.className = 'friends-actions';
    actions.append(button('Aktualisieren', () => renderFriends()), button('Abmelden', () => act('logout')));
    body.append(actions);
    body.append(toggles([
      ['Nachrichtenton', 'Bei neuen Chatnachrichten und geteilten Modpacks', S.friendsSound !== false, (value) => setS({ friendsSound: value })],
      ['Pop-up bei Nachrichten', 'In Modstack oder als Windows-Benachrichtigung', S.friendsPopup !== false, (value) => setS({ friendsPopup: value })],
    ]));
    const rows = await api.invoke('friends:list');
    if (!panel.isConnected) return;
    const unread = await api.invoke('friends:unread');
    if (!panel.isConnected) return;
    markUnreadFriendChats(unread);
    if (friendShareInstance) status.textContent = 'Wähle den Chat, an den du die Instanz senden möchtest.';
    for (const [title, list, empty] of [
      ['Freundesliste', rows.filter((item) => item.accepted), 'Noch keine Freunde hinzugefügt.'],
      ['Eingehende Anfragen', rows.filter((item) => !item.accepted && item.incoming), 'Keine eingehenden Anfragen.'],
      ['Gesendete Anfragen', rows.filter((item) => !item.accepted && !item.incoming), 'Keine gesendeten Anfragen.'],
    ]) {
      const card = document.createElement('section');
      card.className = 'card';
      const heading = document.createElement('h2');
      heading.textContent = title;
      card.append(heading);
      if (!list.length) {
        const hint = document.createElement('p');
        hint.textContent = empty;
        card.append(hint);
      }
      for (const entry of list) {
        const row = document.createElement('div');
        row.className = 'friends-row';
        const name = document.createElement('b');
        name.textContent = entry.name;
        row.append(name);
        const respond = (accept) => act('respond', { id: entry.id, accept });
        if (entry.accepted) {
          const chat = button(unreadFriendChats.has(entry.id) ? 'Chat · Neu' : 'Chat', () => openFriendChat(entry), true);
          chat.dataset.chat = entry.id;
          row.append(chat);
        }
        if (!entry.accepted && entry.incoming) row.append(button('Annehmen', () => respond(true), true));
        row.append(button(entry.accepted ? 'Entfernen' : entry.incoming ? 'Ablehnen' : 'Zurückziehen', async () => {
          if (entry.accepted && !await ask({ title: 'Freund entfernen?', text: entry.name, okText: 'Entfernen', danger: true })) return;
          respond(false);
        }));
        card.append(row);
      }
      body.append(card);
    }
  } catch (err) {
    status.textContent = errText(err);
    status.classList.add('err');
    body.replaceChildren(button('Erneut versuchen', () => renderFriends()), button('Abmelden', () => act('logout')));
  }
}

function openFriendChat(entry) {
  const selectedInstance = friendShareInstance;
  friendShareInstance = undefined;
  const panel = document.createElement('section');
  panel.className = 'friends-panel friend-chat';
  panel.innerHTML = `
    <header><button type="button" class="ghost chat-back">‹ Freunde</button><h1></h1><button type="button" class="ghost chat-refresh">Aktualisieren</button></header>
    <p class="friends-status" role="status"></p>
    <div class="chat-scroll" aria-label="Nachrichten" tabindex="0"></div>
    <form class="chat-compose">
      <textarea rows="2" maxlength="2000" placeholder="Nachricht schreiben …" aria-label="Nachricht" required></textarea>
      <button class="primary">Senden</button>
    </form>
    <form class="chat-share">
      <select aria-label="Instanz zum Teilen" required><option value="">Instanz auswählen …</option></select>
      <button class="ghost">Modpack senden</button>
    </form>`;
  $('#content').replaceChildren(panel);
  $('h1', panel).textContent = entry.name;
  const status = $('.friends-status', panel), messages = $('.chat-scroll', panel);
  const composer = $('.chat-compose', panel), text = $('textarea', composer);
  const share = $('.chat-share', panel), instances = $('select', share);
  for (const instance of insts) {
    const option = new Option(instance.name, instance.id);
    instances.add(option);
    if (instance.id === selectedInstance) instances.value = instance.id;
  }
  $('button', share).disabled = !insts.length;
  let reading = false, sending = false, rendered = '';
  const isOpen = () => panel.isConnected && view === 'friends';
  const time = new Intl.DateTimeFormat('de-DE', { dateStyle: 'short', timeStyle: 'short' });

  function paint(rows) {
    const ids = rows.map((row) => row.messageId).join(',');
    if (ids === rendered && messages.childNodes.length) return;
    const atBottom = !messages.childNodes.length || messages.scrollHeight - messages.scrollTop - messages.clientHeight < 60;
    rendered = ids;
    messages.replaceChildren();
    if (!rows.length) {
      const empty = document.createElement('p');
      empty.textContent = 'Hier könnt ihr Nachrichten und Modpacks austauschen.';
      messages.append(empty);
    }
    for (const row of rows) {
      const bubble = document.createElement('article');
      bubble.className = 'chat-message' + (row.mine ? ' mine' : '');
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
    if (atBottom) messages.scrollTop = messages.scrollHeight;
  }

  async function refresh() {
    if (reading || !isOpen()) return;
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
    } finally { reading = false; }
  }

  async function send(channel, form, data, confirm) {
    if (sending) return false;
    sending = true;
    delete status.dataset.readError;
    status.classList.remove('err');
    status.textContent = '';
    const button = $('button', form);
    button.disabled = true;
    try {
      if (confirm && !await confirm()) return false;
      await api.invoke(channel, { id: entry.id, ...data });
      // If a read was already in flight, its result may predate this write.
      if (reading) setTimeout(refresh, 500);
      else await refresh();
      return true;
    } catch (error) {
      status.textContent = errText(error);
      status.classList.add('err');
      return false;
    } finally { sending = false; button.disabled = false; }
  }

  $('.chat-back', panel).onclick = () => { activeFriendChat = undefined; renderFriends(); };
  $('.chat-refresh', panel).onclick = refresh;
  text.onkeydown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); composer.requestSubmit(); }
  };
  composer.onsubmit = async (event) => {
    event.preventDefault();
    const message = text.value;
    if (await send('friends:sendText', composer, { text: message }) && text.value === message) text.value = '';
  };
  share.onsubmit = (event) => {
    event.preventDefault();
    const instanceId = instances.value;
    send('friends:sendPack', share, { instanceId }, async () => {
      const { skipped, name } = await api.invoke('share:code', instanceId);
      const note = skipped.length ? ` ${skipped.length} lokale Einträge sind nur im .mrpack-Export enthalten.` : '';
      return ask({ title: 'Modpack senden?', text: `„${name}“ an ${entry.name} senden?${note}`, okText: 'Senden' });
    });
  };
  activeFriendChat = { entry, panel, refresh };
  refresh();
}
