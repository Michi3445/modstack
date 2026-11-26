let newestCrash = new Map();
let crashCheckRunning = false;

async function checkInstanceCrash(instance) {
  const spot = $('#crashNotice');
  if (!spot || crashCheckRunning || S.crashDiagnostics === false) return;
  crashCheckRunning = true;
  try {
    const [top] = await call('crashes:list', instance.id, true);
    if (!top || cur?.id !== instance.id || !spot.isConnected) return;
    spot.hidden = false;
    spot.querySelector('span').textContent = top.message;
    spot.querySelector('button').onclick = async () => {
      tab = 'settings';
      renderHead();
      await renderSettings();
      document.querySelector('.pack-crashes')?.scrollIntoView({ block: 'start' });
    };
    if (newestCrash.get(instance.id) !== top.key && top.at >= Date.now() - 10 * 60 * 1000) {
      newestCrash.set(instance.id, top.key);
      toast('Minecraft ist abgestürzt: ' + instance.name, true);
    }
  } catch {} finally {
    crashCheckRunning = false;
    if (view === 'inst' && cur && cur.id !== instance.id) checkInstanceCrash(cur);
  }
}

function renderInstanceCrashes(container, instance) {
  if (S.crashDiagnostics === false) return;
  const section = container.querySelector('.pack-crashes');
  section.hidden = false;
  const list = section.querySelector('.crash-list');
  const render = async () => {
    try {
      const entries = await call('crashes:list', instance.id, true);
      list.replaceChildren();
      if (!entries.length) { list.textContent = 'Keine Abstürze gefunden.'; return; }
      for (const crash of entries) {
        const row = document.createElement('section'); row.className = 'crash-card';
        const heading = document.createElement('b'); heading.textContent = 'Minecraft ist abgestürzt';
        const date = document.createElement('small'); date.textContent = new Date(crash.at).toLocaleString('de-DE');
        const desc = document.createElement('p'); desc.textContent = crash.message;
        row.append(heading, date, desc);
        if (crash.mod || crash.modId) {
          const source = document.createElement('small');
          source.textContent = 'Wahrscheinlich beteiligter Mod: ' + (crash.mod?.title || crash.modId);
          row.append(source);
        }
        const args = { id: instance.id, key: crash.key };
        const buttons = [
          ['Crash-Report öffnen', () => call('crashes:open', args)],
          ['Report kopieren', async () => { await call('crashes:copy', args); toast(crash.truncated ? 'Berichtsauszug kopiert' : 'Crash-Report kopiert'); }],
        ];
        const mod = crash.mod && instance.mods.find((m) => m.file === crash.mod.file && !m.disabled);
        if (mod) {
          buttons.push(['Mod deaktivieren', async () => {
            if (!await ask({ title: 'Mod deaktivieren?', text: mod.title, okText: 'Deaktivieren' })) return;
            await call('mods:toggle', { id: instance.id, file: mod.file });
            await load(cur?.id);
          }]);
          if (instance.history?.some((change) => change.next?.file === mod.file)) {
            buttons.push(['Vorherige Version', async () => undoModChange(instance, await call('history:previous', { id: instance.id, file: mod.file }))]);
          }
        }
        if (crash.type === 'dependency' && crash.dependency) {
          buttons.push(['Fehlende Abhängigkeit installieren', async () => {
            if (!await ask({ title: 'Abhängigkeit installieren?', text: crash.dependency, okText: 'Installieren' })) return;
            const installed = await work('Prüfe Modrinth …', () => call('crashes:installDependency', args));
            if (installed) { await load(cur?.id); toast('Abhängigkeit installiert'); return; }
            searchState.mod = { q: crash.dependency, offset: 0 };
            tab = 'search-mod';
            select(insts.find((item) => item.id === instance.id));
            toast('Wähle die passende Abhängigkeit in der Modrinth-Suche.');
          }]);
        }
        if (crash.type === 'memory') {
          buttons.push(['Mehr RAM geben', () => {
            openPackSettings(instance);
            document.querySelector('#packConfig')?.scrollIntoView({ block: 'start' });
            document.querySelector('#ramSw')?.focus();
          }]);
        }
        row.append(btns(buttons.map(([label, fn]) => [label, async () => { try { await fn(); } catch {} }, 'ghost sm'])));
        list.append(row);
      }
    } catch (error) { list.textContent = errText(error); }
  };
  render();
}
