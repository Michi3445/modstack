async function showPatchNotes(unseen = false) {
  const notes = await api.invoke('patchNotes:get', { unseen }).catch(() => null);
  if (!notes || document.querySelector('dialog[open]')) return;
  const { dialog, heading, body, footer } = detailDialog('Neu in Modstack ' + notes.version, 'patch-notes-dialog');
  heading.id = 'patchNotesTitle';
  dialog.setAttribute('aria-labelledby', heading.id);
  for (const change of notes.changes) {
    const section = document.createElement('section');
    const title = document.createElement('h3');
    title.textContent = change.title;
    const text = document.createElement('p');
    text.textContent = change.text;
    section.append(title, text);
    body.append(section);
  }
  const close = footer.querySelector('button');
  close.className = 'primary';
  close.textContent = 'Alles klar';
  footer.prepend(syncButton('Auf GitHub ansehen', () => call('app:openUrl',
    'https://github.com/Michi3445/modstack/releases/tag/v' + notes.version)));
  dialog.onclose = () => {
    dialog.remove();
    api.invoke('patchNotes:seen', notes.version).catch(() => {});
  };
}
