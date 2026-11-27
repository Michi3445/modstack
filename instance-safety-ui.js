async function undoModChange(instance, key, through = false) {
  if (!key) { toast('Für diesen Mod gibt es keine frühere Version.'); return; }
  if (!await ask({
    title: through ? 'Alle Änderungen bis hier rückgängig machen?' : 'Mod-Änderung rückgängig machen?',
    text: 'Die betroffenen Dateien dieser Instanz werden durch ihre gespeicherten Versionen ersetzt.',
    okText: 'Rückgängig machen', danger: true,
  })) return;
  try {
    await work('Stelle Mod-Versionen wieder her …', () => call('history:undo', { id: instance.id, key, through }));
    await load(cur?.id);
    toast('Mod-Verlauf wiederhergestellt');
  } catch {}
}

function renderInstanceSafety(container, instance) {
  const action = (label, fn) => Object.assign(document.createElement('button'), {
    type: 'button', className: 'ghost sm', textContent: label, onclick: fn,
  });
  function row(title, caption, buttons) {
    const r = document.createElement('div'); r.className = 'safety-row';
    const text = document.createElement('div');
    const name = document.createElement('b'); name.textContent = title;
    const info = document.createElement('small'); info.textContent = caption;
    text.append(name, info);
    const actions = document.createElement('div'); actions.className = 'opts'; actions.append(...buttons);
    r.append(text, actions);
    return r;
  }
  const backupList = document.createElement('div');
  const historyList = document.createElement('div');
  async function showBackups() {
    try {
      const items = await call('backups:list', instance.id, true);
      backupList.replaceChildren(...items.map((item) => row(
        item.worlds.join(', ') || 'Instanz-Konfiguration',
        new Date(item.at).toLocaleString('de-DE') + ' · ' + item.reason + ' · ' + fmtBytes(item.bytes),
        [action('Wiederherstellen', async () => {
          if (!await ask({ title: 'Welt-Backup wiederherstellen?', text: 'Modstack sichert zuerst den aktuellen Stand. Danach werden die gesicherten Welten und gegebenenfalls die Konfiguration wiederhergestellt.', okText: 'Wiederherstellen', danger: true })) return;
          try {
            await work('Stelle Backup wieder her …', () => call('backups:restore', { id: instance.id, key: item.id }));
            await showBackups();
            toast('Backup wiederhergestellt');
          } catch {}
        })],
      )));
      if (!items.length) backupList.textContent = 'Noch keine Backups vorhanden.';
    } catch (error) { backupList.textContent = errText(error); }
  }
  container.querySelector('.pack-backups').append(
    action('Backup erstellen', async () => {
      try {
        await work('Erstelle Welt-Backup …', () => call('backups:create', instance.id));
        await showBackups();
        toast('Backup erstellt');
      } catch {}
    }), backupList,
  );
  container.querySelector('.pack-history').append(historyList);
  showBackups();
  call('history:list', instance.id, true).then((items) => {
    historyList.replaceChildren(...items.slice().reverse().map((item) => row(
      item.config ? 'Pack-Synchronisierung' : item.old?.title || item.next?.title || item.old?.file || item.next?.file,
      new Date(item.at).toLocaleString('de-DE') + ' · ' + (item.config ? 'Pack-Version ' + item.config.sync.revision :
        !item.old ? 'Hinzugefügt' : item.next ? (item.old.version || item.old.file) + ' → ' + (item.next.version || item.next.file) : 'Entfernt'),
      [action('Rückgängig machen', () => undoModChange(instance, item.id)),
        action('Alles bis hier rückgängig', () => undoModChange(instance, item.id, true))],
    )));
    if (!items.length) historyList.textContent = 'Noch keine Änderungen gespeichert.';
  }).catch((error) => { historyList.textContent = errText(error); });
}
