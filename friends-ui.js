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
    const rows = await api.invoke('friends:list');
    if (!panel.isConnected) return;
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
