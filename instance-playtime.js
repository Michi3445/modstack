const fs = require('node:fs');
const path = require('node:path');

module.exports = function instancePlaytime({ file, running, legacyTicks, resolveId, enabled, onSample = () => {}, now = Date.now }) {
  let totals;
  try { totals = new Map(Object.entries(JSON.parse(fs.readFileSync(file, 'utf8'))).filter(([, n]) => Number.isSafeInteger(n) && n >= 0)); }
  catch { totals = new Map(); }
  let active = new Set(), sampledAt, request;

  function save() {
    const temp = file + '.tmp';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temp, JSON.stringify(Object.fromEntries(totals)));
    fs.renameSync(temp, file);
  }

  function sample() {
    if (request) return request;
    request = (async () => {
      const observed = new Set((await running()).map(resolveId).filter(Boolean));
      const at = now();
      const elapsed = sampledAt === undefined ? 0 : Math.floor((at - sampledAt) / 50);
      let changed = false;
      if (enabled()) {
        for (const id of observed) {
          if (!totals.has(id)) { totals.set(id, legacyTicks(id)); changed = true; }
          if (active.has(id) && elapsed > 0 && elapsed <= 600) {
            totals.set(id, totals.get(id) + elapsed);
            changed = true;
          }
        }
      }
      active = observed;
      sampledAt = at;
      if (changed) save();
      onSample([...active]);
      return [...active];
    })().finally(() => { request = undefined; });
    return request;
  }

  return { sample, ticks: (id, fallback) => totals.get(id) ?? fallback };
};
