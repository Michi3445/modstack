let minecraftDefaultsTab = 'launch';
const minecraftOptionNumber = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 2 });

function minecraftOptionRow(option) {
  const row = document.createElement('div');
  row.className = 'minecraft-option-row';
  const label = document.createElement('label');
  label.htmlFor = 'minecraft-default-' + option.id;
  label.textContent = option.label;
  const details = [option.hint, option.since && 'ab Minecraft ' + option.since, option.before && 'vor Minecraft ' + option.before].filter(Boolean);
  if (details.length) {
    const hint = document.createElement('small');
    hint.textContent = details.join(' · ');
    label.append(hint);
  }
  row.append(label);
  const field = document.createElement('div');
  field.className = 'minecraft-option-field';
  const input = document.createElement(option.choices ? 'select' : 'input');
  input.id = label.htmlFor;
  let saved = S.defaultMinecraftOptions?.[option.id] ?? null;
  let desired = saved;
  let saving = false;
  let reset, output;
  if (option.choices) {
    input.add(new Option('Keine Vorgabe', ''));
    for (const [index, [, name]] of option.choices.entries()) input.add(new Option(name, String(index)));
    field.append(input);
  } else {
    field.classList.add('minecraft-option-range');
    Object.assign(input, { type: 'range', min: option.min, max: option.max, step: option.step || 1 });
    output = document.createElement('output');
    output.htmlFor.add(input.id);
    reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'ghost sm';
    reset.textContent = '↺';
    reset.title = 'Vorgabe entfernen';
    reset.setAttribute('aria-label', 'Vorgabe entfernen für ' + option.label);
    reset.onclick = () => save(null);
    field.append(input, output, reset);
    input.oninput = () => showRange(input.valueAsNumber);
    input.onclick = () => save(input.valueAsNumber);
    input.onkeydown = (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      save(input.valueAsNumber);
    };
  }
  row.append(field);

  function showRange(value) {
    const unit = option.unit ? ' ' + option.unit : '';
    const text = value == null ? 'Keine Vorgabe' : option.display?.[value] ?? minecraftOptionNumber.format(value) + unit;
    output.textContent = text;
    input.setAttribute('aria-valuetext', text);
    field.toggleAttribute('data-unset', value == null);
  }

  function sync(value) {
    if (option.choices) {
      const index = option.choices.findIndex(([choice]) => choice === value);
      input.value = index === -1 ? '' : String(index);
    } else {
      input.value = value ?? option.initial ?? option.min;
      showRange(value);
      reset.disabled = value == null;
    }
  }

  async function save(value) {
    if (desired === value) return;
    desired = value;
    sync(value);
    if (saving) return;
    saving = true;
    while (saved !== desired) {
      const pending = desired;
      try {
        S = await call('settings:minecraft-option:set', { id: option.id, value: pending });
        saved = pending;
      } catch {
        if (desired === pending) {
          desired = saved;
          sync(saved);
        }
      }
    }
    saving = false;
  }

  input.onchange = () => {
    const value = input.value === '' ? null : (option.choices ? option.choices[Number(input.value)][0] : input.valueAsNumber);
    save(value);
  };
  sync(saved);
  return row;
}

function renderMinecraftDefaults(container, searching) {
  const categories = [
    { id: 'launch', label: 'Start' },
    ...MINECRAFT_OPTION_GROUPS,
    { id: 'bindings', label: 'Tastenbelegung' },
  ];
  const matches = (id) => searching || minecraftDefaultsTab === id;
  if (!searching) {
    const navigation = document.createElement('div');
    navigation.className = 'minecraft-default-tabs';
    navigation.setAttribute('role', 'group');
    navigation.setAttribute('aria-label', 'Kategorien für Modpack-Standards');
    for (const { id, label } of categories) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.category = id;
      button.textContent = label;
      button.setAttribute('aria-pressed', String(matches(id)));
      button.onclick = () => {
        minecraftDefaultsTab = id;
        renderSettingsBody(true);
        document.querySelector(`#scont [data-category="${id}"]`)?.focus({ preventScroll: true });
      };
      navigation.append(button);
    }
    container.append(navigation);
  }
  if (matches('launch')) {
    const ram = document.createElement('div');
    ram.append(toggleLine('Eigenen Standard-RAM verwenden', 'Aus = Launcher-Standard', !!S.defaultRam, (v) => setS({ defaultRam: v ? 4096 : 0 })));
    if (S.defaultRam) ram.append(slider('Standard-RAM', 1, Math.max(16, Math.ceil(S.defaultRam / 1024)), 0.5, S.defaultRam / 1024, (v) => v + ' GB', null, (v) => saveQuiet({ defaultRam: Math.round(v * 1024) })));
    container.append(sec('Arbeitsspeicher', 'Vorgabe für neu erstellte und importierte Instanzen.', ram));
    const java = document.createElement('input');
    Object.assign(java, { placeholder: 'z. B. -XX:+UseG1GC', spellcheck: false, value: S.defaultJavaArgs || '' });
    java.className = 'minecraft-java-args';
    java.setAttribute('aria-label', 'Standard-Java-Argumente');
    java.onchange = () => saveQuiet({ defaultJavaArgs: java.value.trim() });
    container.append(sec('Standard-Java-Argumente', 'Für neue Instanzen.', java));
  }
  if (matches('video')) {
    const view = document.createElement('div');
    const fovOn = Number.isInteger(S.defaultFov);
    view.append(toggleLine('Eigenes Sichtfeld verwenden', 'Aus = Sichtfeld des Modpacks oder von Minecraft', fovOn, (v) => setS({ defaultFov: v ? 70 : null })));
    if (fovOn) view.append(slider('Sichtfeld (FOV)', 30, 110, 1, S.defaultFov, (v) => v + '°', null, (v) => saveQuiet({ defaultFov: v })));
    container.append(sec('Sichtfeld (FOV)', '', view));
  }
  for (const { id, label, options } of MINECRAFT_OPTION_GROUPS) {
    if (!matches(id)) continue;
    const rows = document.createElement('div');
    rows.className = 'minecraft-option-list';
    for (const option of options) rows.append(minecraftOptionRow(option));
    container.append(sec(label, '', rows));
  }
  if (matches('bindings')) {
    const keys = document.createElement('div');
    if (searching) keys.append(btns([['Standard-Tastenbelegung öffnen', () => {
      minecraftDefaultsTab = 'bindings';
      selectSetting('defaults');
    }]]));
    container.append(sec('Standard-Tastenbelegung', 'Eigene Vorgaben für Tastatur und Maus überschreiben beim Import die jeweilige Modpack-Belegung.', keys));
    if (!searching) renderKeybinds(keys, { preset: true });
  }
}
