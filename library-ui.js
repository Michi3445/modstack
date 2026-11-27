function detailDialog(title, className) {
  const dialog = document.createElement('dialog');
  dialog.className = className;
  const heading = document.createElement('div');
  heading.className = 'dh';
  heading.textContent = title;
  const body = document.createElement('div');
  body.className = 'db library-dialog-body';
  const footer = document.createElement('div'); footer.className = 'df';
  const close = document.createElement('button');
  close.type = 'button'; close.className = 'ghost'; close.textContent = 'Schließen';
  close.onclick = () => dialog.close();
  footer.append(close);
  dialog.append(heading, body, footer);
  dialog.onclose = () => dialog.remove();
  document.body.append(dialog);
  dialog.showModal();
  return { dialog, heading, body, footer };
}

async function openModPage(instance, item) {
  if (!instance || document.querySelector('dialog[open]')) return;
  const kind = kindOf(item);
  const { dialog, heading, body, footer } = detailDialog(item.title || item.file, 'mod-detail-dialog');
  if (item.file) footer.append(syncButton('Im Ordner zeigen', () => call('app:showMod', { id: instance.id, file: item.file })));
  if (item.projectId) footer.append(syncButton('Auf Modrinth öffnen', () =>
    call('app:openUrl', 'https://modrinth.com/project/' + encodeURIComponent(item.projectId))));
  body.textContent = item.projectId ? 'Modrinth-Projekt wird geladen …' : 'Suche die Datei auf Modrinth …';
  try {
    const project = await api.invoke('mr:project', { id: instance.id, projectId: item.projectId, kind, file: item.file });
    if (!dialog.open) return;
    if (!project) {
      body.textContent = 'Für „' + item.file + '“ wurde keine passende Projektseite auf Modrinth gefunden.';
      return;
    }
    heading.textContent = project.title;
    body.replaceChildren();
    const summary = document.createElement('p'); summary.textContent = project.summary;
    if (Number.isFinite(project.downloads)) summary.append(document.createTextNode(' · ' + project.downloads.toLocaleString('de-DE') + ' Downloads'));
    if (project.icon) {
      const icon = new Image();
      icon.className = 'library-icon'; icon.alt = ''; icon.src = project.icon;
      body.append(icon);
    }
    body.append(summary);
    if (project.gallery.length) {
      const gallery = document.createElement('div'); gallery.className = 'library-gallery';
      for (const src of project.gallery) {
        const img = new Image(); img.src = src; img.loading = 'lazy'; img.alt = project.title;
        gallery.append(img);
      }
      body.append(gallery);
    }
    const versions = document.createElement('p');
    if (!project.versions) versions.textContent = 'Die Versionsliste konnte gerade nicht geladen werden.';
    else versions.textContent = project.versions.length
      ? 'Passende Versionen · ' + project.versions.map((v) => v.version + (v.channel === 'release' ? '' : ' (' + v.channel + ')')).join(', ')
      : 'Für diese Instanz wurde keine passende Version gefunden.';
    body.append(versions);
    if (project.description) {
      const description = document.createElement('div');
      description.className = 'library-description';
      showModDescription(description, project.description);
      body.append(description);
    }
    if (!item.projectId) footer.append(syncButton('Auf Modrinth öffnen', () => call('app:openUrl', project.url)));
    const selected = cur?.id === instance.id ? cur : insts.find((i) => i.id === instance.id);
    const installed = item.file || selected?.mods.some((m) => m.projectId === item.projectId);
    if (!installed && project.versions?.length) {
      footer.append(syncButton('Installieren', async () => {
        const result = await work('Installiere ' + project.title + ' …', () => api.invoke('mr:install', {
          id: instance.id, projectId: item.projectId, kind,
        }));
        dialog.close();
        await load();
        toast(result.warnings.length ? result.warnings.join(' · ') : project.title + ' installiert', !!result.warnings.length);
      }, true));
    }
  } catch (error) { body.textContent = errText(error); }
}

function showModDescription(container, markdown) {
  const html = window.markdownit({ html: true }).render(markdown);
  const content = window.DOMPurify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_TAGS: ['p', 'div', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'img', 'br', 'hr',
      'strong', 'b', 'em', 'i', 's', 'del', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
      'details', 'summary', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
    ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'width', 'height', 'align', 'colspan', 'rowspan', 'start'],
    ALLOWED_URI_REGEXP: /^https:\/\//i,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  });
  for (const link of content.querySelectorAll('a[href]')) {
    const url = URL.parse(link.href);
    if (url?.protocol !== 'https:' || url.username || url.password) {
      link.removeAttribute('href');
      continue;
    }
    link.addEventListener('click', (event) => {
      event.preventDefault();
      call('app:openUrl', url.href);
    });
    link.addEventListener('auxclick', (event) => event.preventDefault());
    link.addEventListener('contextmenu', (event) => event.preventDefault());
  }
  for (const img of content.querySelectorAll('img[src]')) {
    img.loading = 'lazy'; img.referrerPolicy = 'no-referrer';
  }
  container.replaceChildren(content);
}

api.onPlaytimeClose(() => {
  const { dialog, body, footer } = detailDialog('Minecraft läuft noch', 'friend-library-dialog');
  body.textContent = 'Modstack kann im Windows-Infobereich weiter die Spielzeit erfassen. Sobald du Minecraft beendest, schließt sich auch Modstack.';
  let decided = false;
  function respond(choice) {
    decided = true;
    dialog.close();
    return api.invoke('win:closeDecision', choice);
  }
  footer.replaceChildren(
    syncButton('Abbrechen', () => respond('cancel')),
    syncButton('Ganz beenden', () => respond('quit')),
    syncButton('Im Hintergrund weiter', () => respond('background'), true),
  );
  dialog.onclose = () => {
    dialog.remove();
    if (!decided) api.invoke('win:closeDecision', 'cancel').catch(() => {});
  };
});

let scanningMods = false;
async function refreshFolderMods(instance, explicit = false) {
  if (!instance || scanningMods || (busy && !explicit)) return;
  scanningMods = true;
  try {
    const next = await api.invoke('instances:rescanMods', instance.id);
    if (JSON.stringify(next.mods) === JSON.stringify(instance.mods)) {
      if (explicit) toast('Instanzordner ist abgeglichen');
      return;
    }
    const index = insts.findIndex((i) => i.id === instance.id);
    if (index < 0) return;
    insts[index] = next;
    if (cur?.id === instance.id && view === 'inst') {
      cur = next;
      if (tab === 'mods') drawMods();
      renderHead();
    }
    renderList();
    if (explicit) toast('Instanzordner abgeglichen');
  } catch (error) {
    if (explicit) toast(errText(error), true);
  } finally { scanningMods = false; }
}

async function showFriendLibrary(entry) {
  if (!entry?.accepted || entry.group || document.querySelector('dialog[open]')) return;
  const { dialog, body } = detailDialog(entry.name, 'friend-library-dialog');
  const profile = document.createElement('div'); profile.className = 'friend-library-head';
  profile.append(friendAvatar(entry), document.createTextNode(friendActivity(entry) || 'Freund'));
  body.append(profile);
  const title = document.createElement('h3'); title.textContent = 'Mit dir geteilte Modpacks';
  const packs = document.createElement('div');
  body.append(title, packs);
  let before, count = 0;
  const seen = new Set();
  const more = syncButton('Ältere Packs laden', loadPage);
  body.append(more);
  async function loadPage() {
    try {
      const page = await api.invoke('friends:shared', { id: entry.id, before });
      if (!dialog.open) return;
      before = page.before;
      more.hidden = !before;
      for (const row of page.packs) {
        if (row.mine || seen.has(row.content)) continue;
        seen.add(row.content); count++;
        const card = document.createElement('article'); card.className = 'friend-library-pack';
        if (row.kind === 'sync') renderSharedSyncCard(card, row, entry.id, () => dialog.close());
        else {
          const name = document.createElement('strong'); name.textContent = row.title;
          card.append(name, syncButton('Installieren', async () => {
            if (!await ask({ title: 'Modpack installieren?', text: row.title, okText: 'Installieren' })) return;
            dialog.close();
            await cfRun('share:importCode', row.content);
          }, true));
        }
        packs.append(card);
      }
      title.textContent = count ? 'Mit dir geteilte Modpacks' : 'Auf dieser Seite gibt es keine geteilten Modpacks';
    } catch (error) { packs.textContent = errText(error); }
  }
  more.hidden = true;
  await loadPage();
}
