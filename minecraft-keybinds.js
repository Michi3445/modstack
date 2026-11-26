const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const controls = [
  ['Bewegung', [
    ['forward', 'Vorwärts', 'KeyW'], ['back', 'Rückwärts', 'KeyS'],
    ['left', 'Nach links', 'KeyA'], ['right', 'Nach rechts', 'KeyD'],
    ['jump', 'Springen', 'Space'], ['sneak', 'Schleichen', 'ShiftLeft'], ['sprint', 'Sprinten', 'ControlLeft'],
  ]],
  ['Interaktion', [
    ['attack', 'Angreifen / Abbauen', 'Mouse0'], ['use', 'Benutzen / Platzieren', 'Mouse2'],
    ['pickItem', 'Block auswählen', 'Mouse1'], ['drop', 'Gegenstand fallen lassen', 'KeyQ'],
    ['swapOffhand', 'Hände wechseln', 'KeyF', 9], ['inventory', 'Inventar', 'KeyE'],
  ]],
  ['Leiste', Array.from({ length: 9 }, (_, i) => [`hotbar.${i + 1}`, `Slot ${i + 1}`, `Digit${i + 1}`])],
  ['Mehrspieler & Ansicht', [
    ['chat', 'Chat öffnen', 'KeyT'], ['command', 'Befehl eingeben', 'Slash'], ['playerlist', 'Spielerliste', 'Tab'],
    ['advancements', 'Fortschritte', 'KeyL', 12], ['togglePerspective', 'Perspektive wechseln', 'F5'],
    ['screenshot', 'Screenshot', 'F2'], ['fullscreen', 'Vollbild', 'F11'],
  ]],
];

// LWJGL 2 codes migrate through Minecraft's own options data fixes on a fresh install.
const keys = {
  Unbound: ['key.keyboard.unknown', 0, 'Unbelegt'],
  Mouse0: ['key.mouse.left', -100, 'Linke Maustaste'],
  Mouse1: ['key.mouse.middle', -98, 'Mittlere Maustaste'],
  Mouse2: ['key.mouse.right', -99, 'Rechte Maustaste'],
  Mouse3: ['key.mouse.4', -97, 'Maustaste 4'],
  Mouse4: ['key.mouse.5', -96, 'Maustaste 5'],
};
function keyboard(code, name, number, label = code) {
  keys[code] = ['key.keyboard.' + name, number, label];
}
const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const letterCodes = [30, 48, 46, 32, 18, 33, 34, 35, 23, 36, 37, 38, 50, 49, 24, 25, 16, 19, 31, 20, 22, 47, 17, 45, 21, 44];
for (const [index, letter] of [...letters].entries()) {
  keyboard('Key' + letter, letter.toLowerCase(), letterCodes[index], letter);
}
const padCodes = [82, 79, 80, 81, 75, 76, 77, 71, 72, 73];
for (let i = 0; i < 10; i++) {
  keyboard('Digit' + i, String(i), i === 0 ? 11 : i + 1, String(i));
  keyboard('Numpad' + i, 'keypad.' + i, padCodes[i], 'Num ' + i);
}
for (let i = 1; i <= 12; i++) {
  keyboard('F' + i, 'f' + i, i <= 10 ? 58 + i : 76 + i);
}
for (const [code, name, number, label] of [
  ['Space', 'space', 57, 'Leertaste'], ['Enter', 'enter', 28, 'Enter'],
  ['Escape', 'escape', 1, 'Esc'], ['Tab', 'tab', 15, 'Tab'],
  ['ShiftLeft', 'left.shift', 42, 'Umschalt links'], ['ShiftRight', 'right.shift', 54, 'Umschalt rechts'],
  ['ControlLeft', 'left.control', 29, 'Strg links'], ['ControlRight', 'right.control', 157, 'Strg rechts'],
  ['AltLeft', 'left.alt', 56, 'Alt links'], ['AltRight', 'right.alt', 184, 'Alt rechts'],
  ['ArrowUp', 'up', 200, '↑'], ['ArrowDown', 'down', 208, '↓'],
  ['ArrowLeft', 'left', 203, '←'], ['ArrowRight', 'right', 205, '→'],
  ['Backspace', 'backspace', 14, 'Rücktaste'], ['Delete', 'delete', 211, 'Entf'],
  ['Insert', 'insert', 210, 'Einfg'], ['Home', 'home', 199, 'Pos1'], ['End', 'end', 207, 'Ende'],
  ['PageUp', 'page.up', 201, 'Bild ↑'], ['PageDown', 'page.down', 209, 'Bild ↓'],
  ['CapsLock', 'caps.lock', 58, 'Feststelltaste'], ['NumLock', 'num.lock', 69, 'Num Lock'],
  ['Minus', 'minus', 12, '-'], ['Equal', 'equal', 13, '='], ['BracketLeft', 'left.bracket', 26, '['],
  ['BracketRight', 'right.bracket', 27, ']'], ['Backslash', 'backslash', 43, '\\'],
  ['Semicolon', 'semicolon', 39, ';'], ['Quote', 'apostrophe', 40, "'"], ['Backquote', 'grave.accent', 41, '`'],
  ['Comma', 'comma', 51, ','], ['Period', 'period', 52, '.'], ['Slash', 'slash', 53, '/'],
  ['NumpadAdd', 'keypad.add', 78, 'Num +'], ['NumpadSubtract', 'keypad.subtract', 74, 'Num −'],
  ['NumpadMultiply', 'keypad.multiply', 55, 'Num ×'], ['NumpadDivide', 'keypad.divide', 181, 'Num ÷'],
  ['NumpadEnter', 'keypad.enter', 156, 'Num Enter'],
]) keyboard(code, name, number, label);

function options(file) {
  let text = '';
  // Key names and values use ASCII. Keep the other lines byte-for-byte, including older encodings.
  try { text = fs.readFileSync(file, 'latin1'); }
  catch (err) { if (err.code !== 'ENOENT') throw err; }
  const bom = text.startsWith('\xEF\xBB\xBF') ? '\xEF\xBB\xBF' : '';
  const lines = text.slice(bom.length).split(/(\r\n|\n|\r)/);
  const entries = new Map();
  for (let i = 0; i < lines.length; i += 2) {
    const split = lines[i].indexOf(':');
    if (split !== -1) entries.set(lines[i].slice(0, split), { index: i, value: lines[i].slice(split + 1) });
  }
  return { bom, lines, entries };
}

function availableControls(mc) {
  const minor = /^1\.(\d+)(?:\.|$|[-_])/.exec(mc)?.[1];
  return controls.map(([title, list]) => [title, list.filter(([, , , since = 0]) => !minor || Number(minor) >= since)]);
}

function bindings(file, mc) {
  const { entries } = options(file);
  const byValue = new Map();
  for (const [code, [modern, legacy]] of Object.entries(keys)) {
    byValue.set(modern, code);
    byValue.set(String(legacy), code);
  }
  return {
    labels: Object.fromEntries(Object.entries(keys).map(([code, [, , label]]) => [code, label])),
    groups: availableControls(mc).map(([title, list]) => ({
      title,
      bindings: list.map(([id, label, standard]) => {
        const value = entries.get('key_key.' + id)?.value ?? null;
        return { id, label, standard, value, code: value === null ? standard : byValue.get(value) };
      }),
    })),
  };
}

function writeBinding(file, mc, { action, code, expected }) {
  if (!Object.hasOwn(keys, code) || !availableControls(mc).some(([, list]) => list.some(([id]) => id === action))) {
    throw new Error('Diese Tastenbelegung wird nicht unterstützt.');
  }
  const { bom, lines, entries } = options(file);
  const name = 'key_key.' + action;
  const entry = entries.get(name);
  if ((entry?.value ?? null) !== expected) throw new Error('Die Belegung wurde inzwischen geändert. Wähle die Aktion erneut aus.');
  const [modern, legacy] = keys[code];
  const legacyGame = /^1\.(?:[0-9]|1[0-2])(?:\.|$|[-_])/.test(mc);
  // Pre-1.13 files and files with no data version use the original numeric format.
  const value = !legacyGame && Number(entries.get('version')?.value) >= 1519 ? modern : String(legacy);
  if (entry?.value === value) return;
  const line = name + ':' + value;
  if (entry) lines[entry.index] = line;
  else {
    const eol = lines[1] || '\n';
    if (lines.at(-1)) lines.push(eol, line);
    else lines[lines.length - 1] = line;
    lines.push(eol);
  }
  const temporary = path.join(path.dirname(file), '.options-' + randomUUID() + '.tmp');
  try {
    fs.writeFileSync(temporary, bom + lines.join(''), { encoding: 'latin1', flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

module.exports = { bindings, writeBinding };
