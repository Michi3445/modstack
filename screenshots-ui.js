async function encodeChatScreenshot(source) {
  const image = new Image();
  image.src = source;
  await image.decode();
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { alpha: false });
  for (const size of [800, 640, 480, 320]) {
    const scale = Math.min(1, size / Math.max(image.naturalWidth, image.naturalHeight));
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    context.fillStyle = '#111';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const result = canvas.toDataURL('image/webp', 0.72);
    if (result.startsWith('data:image/webp;base64,') && result.length <= 64000) {
      return api.invoke('screenshots:chatPayload', result);
    }
  }
  throw new Error('Der Screenshot ist zu groß für den Chat.');
}

async function shareScreenshot(instance, shot) {
  const [friends, groups] = await Promise.all([api.invoke('friends:list'), api.invoke('friends:groups:list')]);
  const chats = [...friends.filter((friend) => friend.accepted), ...groups.filter((group) => group.state === 'member')];
  if (!chats.length) { toast('Füge zuerst einen Freund hinzu oder tritt einer Gruppe bei.'); return; }
  const choice = await syncDialog('Screenshot im Chat teilen', chats, [], [], 'Senden');
  if (!choice) return;
  const isGroup = choice.pick.startsWith('g-');
  const channel = isGroup ? 'friends:groups:sendScreenshot' : 'friends:sendScreenshot';
  const original = await api.invoke('screenshots:shareSource', { id: instance.id, name: shot.name });
  const content = await encodeChatScreenshot(original);
  await api.invoke(channel, { id: choice.pick, content });
  toast('Screenshot im Chat geteilt');
}

function showScreenshotViewer(instance, items, index, onRemove = () => {}) {
  if (document.querySelector('dialog[open]') || !items[index]) return;
  const dlg = document.createElement('dialog');
  dlg.className = 'screenshot-viewer';
  dlg.innerHTML = '<div class="dh"><span></span><button type="button" class="iconbtn" aria-label="Schließen">×</button></div>' +
    '<div class="screenshot-large"><button type="button" class="ghost" aria-label="Vorheriger Screenshot">‹</button>' +
    '<img alt=""><button type="button" class="ghost" aria-label="Nächster Screenshot">›</button></div><div class="df"></div>';
  const heading = dlg.querySelector('.dh span');
  const img = dlg.querySelector('img');
  const [back, next] = dlg.querySelectorAll('.screenshot-large button');
  const actions = dlg.querySelector('.df');
  const close = dlg.querySelector('.dh button');
  const button = (label, action, cls = 'ghost') => {
    const el = Object.assign(document.createElement('button'), { type: 'button', textContent: label, className: cls });
    el.onclick = async () => {
      el.disabled = true;
      try { await action(); } catch (error) { toast(errText(error), true); }
      finally { el.disabled = false; }
    };
    return el;
  };
  close.onclick = () => dlg.close();
  dlg.onclose = () => dlg.remove();
  function draw() {
    const shot = items[index];
    if (!shot) { dlg.close(); return; }
    const args = { id: instance.id, name: shot.name };
    heading.textContent = shot.name;
    img.alt = shot.name;
    img.removeAttribute('src');
    back.disabled = index < 1; next.disabled = index + 1 >= items.length;
    api.invoke('screenshots:view', args).then((src) => {
      if (dlg.isConnected && items[index] === shot) img.src = src;
    }).catch((error) => { if (items[index] === shot) toast(errText(error), true); });
    actions.replaceChildren(
      button('In die Zwischenablage', async () => { await api.invoke('screenshots:copy', args); toast('Screenshot kopiert'); }),
      button('Im Ordner zeigen', () => api.invoke('screenshots:reveal', args)),
      button('Im Chat teilen', () => shareScreenshot(instance, shot)),
      button('Löschen', async () => {
        if (!await ask({ title: 'Screenshot löschen?', text: shot.name, okText: 'Löschen', danger: true })) return;
        await api.invoke('screenshots:remove', args);
        const pos = items.indexOf(shot);
        if (pos >= 0) items.splice(pos, 1);
        index = Math.max(0, Math.min(index, items.length - 1));
        onRemove();
        draw();
      }, 'danger'),
    );
  }
  back.onclick = () => { if (index > 0) { index--; draw(); } };
  next.onclick = () => { if (index + 1 < items.length) { index++; draw(); } };
  dlg.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    (event.key === 'ArrowLeft' ? back : next).click();
  });
  document.body.append(dlg);
  dlg.showModal();
  draw();
}

function screenshotTile(instance, item, open, observer) {
  const tile = document.createElement('button');
  tile.className = 'screenshot-tile';
  tile.type = 'button';
  tile.title = item.name;
  const img = document.createElement('img');
  img.alt = item.name;
  const load = () => api.invoke('screenshots:thumbnail', { id: instance.id, name: item.name })
    .then((src) => { if (img.isConnected) img.src = src; }).catch(() => {});
  tile.append(img);
  tile.onclick = open;
  if (observer) observer.observe(tile, load);
  else load();
  return tile;
}

async function renderScreenshots(instance) {
  const container = $('#content');
  const panel = document.createElement('section');
  panel.className = 'screenshots-panel';
  panel.textContent = 'Screenshots werden geladen …';
  container.replaceChildren(panel);
  try {
    const items = await api.invoke('screenshots:list', instance.id);
    if (!panel.isConnected) return;
    const pending = new Map(), queue = [];
    let active = 0;
    function pump() {
      while (active < 4 && queue.length && panel.isConnected) {
        active++;
        queue.shift()().finally(() => { active--; pump(); });
      }
    }
    const watch = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting || !pending.has(entry.target)) continue;
        queue.push(pending.get(entry.target));
        pending.delete(entry.target);
        watch.unobserve(entry.target);
      }
      pump();
    }, { root: container, rootMargin: '160px' });
    const observer = { observe(tile, load) { pending.set(tile, load); watch.observe(tile); } };
    const date = new Intl.DateTimeFormat('de-DE', { dateStyle: 'full' });
    function draw() {
      panel.replaceChildren();
      pending.clear(); watch.disconnect(); queue.length = 0;
      if (!items.length) { panel.textContent = 'Noch keine Screenshots. Drücke beim Spielen F2, um einen aufzunehmen.'; return; }
      let heading, group;
      for (const item of items) {
        const day = date.format(item.at);
        if (day !== heading) {
          heading = day;
          const label = document.createElement('h3'); label.textContent = day;
          group = document.createElement('div'); group.className = 'screenshot-grid';
          panel.append(label, group);
        }
        group.append(screenshotTile(instance, item, () => showScreenshotViewer(instance, items, items.indexOf(item), draw), observer));
      }
    }
    draw();
  } catch (error) { if (panel.isConnected) panel.textContent = errText(error); }
}

async function drawRecentScreenshots(container, instance) {
  if (S.screenshotsEnabled === false) return;
  try {
    const items = await api.invoke('screenshots:list', instance.id);
    if (!container.isConnected) return;
    if (!items.length) { container.replaceChildren(); return; }
    const section = document.createElement('div'); section.className = 'det-sec';
    const title = document.createElement('h4'); title.textContent = 'Letzte Screenshots';
    const grid = document.createElement('div'); grid.className = 'screenshot-grid recent-shots';
    items.slice(0, 4).forEach((shot, index) => grid.append(screenshotTile(instance, shot,
      () => showScreenshotViewer(instance, items, index, () => drawRecentScreenshots(container, instance)))));
    section.append(title, grid);
    container.replaceChildren(section);
  } catch {}
}

function renderChatScreenshot(bubble, row) {
  const image = document.createElement('img');
  image.className = 'chat-screenshot';
  image.loading = 'lazy';
  image.alt = 'Geteilter Minecraft-Screenshot';
  image.src = row.content;
  bubble.append(image);
}
