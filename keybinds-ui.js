let keybindInstance;
let keyLayout;

function keybindLabel(code, labels, fallback = 'Unbelegt') {
  const physical = !code?.startsWith('Numpad') && keyLayout?.get(code);
  return physical?.length === 1 && physical !== ' ' ? physical.toLocaleUpperCase() : labels[code] || fallback;
}

function captureKeybind(binding, data, saveBinding, onSaved, preset) {
  const dialog = document.createElement('dialog');
  dialog.className = 'key-capture';
  dialog.setAttribute('aria-labelledby', 'keyCaptureTitle');
  dialog.innerHTML = `
    <div class="dh" id="keyCaptureTitle"></div>
    <div class="db">
      <div class="key-capture-zone" tabindex="0" aria-label="Eingabe erfassen">Taste drücken oder hier mit der Maus klicken</div>
      <p class="key-feedback" role="status"></p>
      <div class="opts">
        <button type="button" class="ghost sm" data-code="default">${preset ? 'Vorgabe entfernen' : 'Standard wählen'}</button>
        <button type="button" class="ghost sm" data-code="Unbound">Belegung entfernen</button>
      </div>
    </div>
    <div class="df"><button type="button" class="ghost">Abbrechen</button><button type="button" class="primary" disabled>Übernehmen</button></div>`;
  dialog.querySelector('.dh').textContent = binding.label;
  const zone = dialog.querySelector('.key-capture-zone');
  const feedback = dialog.querySelector('.key-feedback');
  const save = dialog.querySelector('.primary');
  let selected;
  let saving = false;
  function select(code) {
    if (saving) return;
    if (code !== null && !Object.hasOwn(data.labels, code)) {
      feedback.textContent = 'Diese Taste wird hier noch nicht unterstützt.';
      return;
    }
    selected = code;
    zone.textContent = code === null ? 'Keine Vorgabe' : keybindLabel(code, data.labels);
    const others = code === null || code === 'Unbound' ? [] : data.groups.flatMap((group) => group.bindings)
      .filter((item) => item.id !== binding.id && item.code === code).map((item) => item.label);
    feedback.textContent = others.length ? 'Auch belegt für ' + others.join(', ') : '';
    save.disabled = false;
    save.focus();
  }
  zone.onkeydown = (event) => {
    if (event.code === 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) select(event.code);
  };
  zone.onpointerdown = (event) => {
    if (event.pointerType !== 'mouse') return;
    event.preventDefault();
    select('Mouse' + event.button);
  };
  zone.oncontextmenu = (event) => event.preventDefault();
  for (const button of dialog.querySelectorAll('[data-code]')) {
    button.onclick = () => select(button.dataset.code === 'default' ? (preset ? null : binding.standard) : button.dataset.code);
  }
  dialog.querySelector('.df .ghost').onclick = () => { if (!saving) dialog.close(); };
  dialog.oncancel = (event) => { if (saving) event.preventDefault(); };
  dialog.onclose = () => dialog.remove();
  save.onclick = async () => {
    if (!dialog.open || saving) return;
    saving = save.disabled = true;
    try {
      const next = await saveBinding({ action: binding.id, code: selected, expected: binding.value });
      dialog.close();
      onSaved(next);
    } catch (error) {
      feedback.textContent = errText(error);
      saving = save.disabled = false;
    }
  };
  document.body.append(dialog);
  dialog.showModal();
  zone.focus();
}

function renderKeybinds(container, { instanceId, preset = false } = {}) {
  if (!preset && !instanceId && !insts.length) {
    container.textContent = 'Erstelle oder importiere zuerst eine Minecraft-Instanz.';
    return;
  }
  let select;
  if (!preset && !instanceId) {
    if (!insts.some((instance) => instance.id === keybindInstance)) {
      keybindInstance = insts.find((instance) => instance.id === cur?.id)?.id || insts[0].id;
    }
    const picker = document.createElement('label');
    picker.className = 'key-instance';
    select = document.createElement('select');
    for (const instance of insts) {
      select.add(new Option(instance.name + ' · ' + instance.mc, instance.id));
    }
    select.value = keybindInstance;
    picker.append('Minecraft-Instanz', select);
    container.append(picker);
  }
  const grid = document.createElement('div');
  grid.className = 'key-groups';
  container.append(grid);
  const layoutReady = keyLayout || navigator.keyboard?.getLayoutMap().then((map) => { keyLayout = map; }).catch(() => {});

  function draw(data, id, focusAction) {
    grid.replaceChildren();
    for (const { title, bindings } of data.groups) {
      const section = document.createElement('section');
      const heading = document.createElement('h3');
      heading.textContent = title;
      section.append(heading);
      for (const binding of bindings) {
        const row = document.createElement('div');
        row.className = 'key-row';
        const name = document.createElement('span');
        name.textContent = binding.label;
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'ghost sm';
        const current = keybindLabel(binding.code, data.labels, binding.value);
        const inherited = preset && binding.value === null;
        edit.textContent = inherited ? 'Keine Vorgabe' : current;
        if (inherited) edit.classList.add('key-inherited');
        edit.title = edit.textContent;
        edit.setAttribute('aria-label', binding.label + ' ändern. Aktuell ' + edit.textContent);
        const save = (change) => preset
          ? api.invoke('settings:keybinds:save', change)
          : api.invoke('instances:keybinds:save', { id, ...change });
        edit.onclick = () => captureKeybind(binding, data, save, (next) => draw(next, id, binding.id), preset);
        row.append(name, edit);
        section.append(row);
      }
      grid.append(section);
    }
    if (focusAction) {
      const index = data.groups.flatMap((group) => group.bindings).findIndex((binding) => binding.id === focusAction);
      grid.querySelectorAll('button')[index]?.focus({ preventScroll: true });
    }
  }
  async function load() {
    const id = instanceId || (select && (keybindInstance = select.value));
    grid.textContent = 'Tastenbelegungen werden geladen …';
    try {
      const data = preset ? await api.invoke('settings:keybinds:get') : await api.invoke('instances:keybinds:get', id);
      await layoutReady;
      if (grid.isConnected && (!select || select.value === id)) draw(data, id);
    } catch (error) {
      if (grid.isConnected && (!select || select.value === id)) grid.textContent = errText(error);
    }
  }
  if (select) select.onchange = load;
  load();
}
