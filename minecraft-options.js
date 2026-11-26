const groups = require('./minecraft-option-definitions');
const definitions = groups.flatMap((group) => group.options);
const byId = new Map(definitions.map((definition) => [definition.id, definition]));

function validValue(definition, value) {
  if (definition.choices) return definition.choices.some(([choice]) => choice === value);
  if (!Number.isFinite(value) || value < definition.min || value > definition.max) return false;
  const steps = (value - definition.min) / (definition.step || 1);
  return Math.abs(steps - Math.round(steps)) < 1e-8;
}

function updateOptionDefaults(stored, { id, value }) {
  const definition = byId.get(id);
  if (!definition || (value !== null && !validValue(definition, value))) {
    throw new Error('Ungültiger Wert für die Minecraft-Vorgabe.');
  }
  const current = Object.fromEntries(definitions
    .filter((option) => validValue(option, stored?.[option.id]))
    .map((option) => [option.id, stored[option.id]]));
  if (value === null) delete current[id];
  else current[id] = value;
  return current;
}

function versionParts(version) {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?(?:$|[-_])/.exec(version);
  return match?.slice(1).map((part) => Number(part || 0));
}

function atLeast(version, limit) {
  if (!version) return false;
  const required = versionParts(limit);
  for (let i = 0; i < required.length; i++) {
    if (version[i] !== required[i]) return version[i] > required[i];
  }
  return true;
}

function serialize(definition, value, version) {
  if (definition.format === 'ambientOcclusion' && !atLeast(version, '1.19')) return value ? '2' : '0';
  if (definition.format === 'clouds' || definition.format === 'enum') {
    return atLeast(version, '1.19') ? JSON.stringify(value) : value;
  }
  return String(definition.scale ? (value - (definition.offset || 0)) / definition.scale : value);
}

function encodeOptionDefaults(stored, mc) {
  const version = versionParts(mc);
  return definitions.filter((definition) =>
    validValue(definition, stored?.[definition.id]) &&
    (!definition.since || atLeast(version, definition.since)) &&
    (!definition.before || (version && !atLeast(version, definition.before))))
    .map((definition) => [definition.id, serialize(definition, stored[definition.id], version)]);
}

function freshOptionsDataVersion(mc) {
  const version = versionParts(mc);
  // 1.21.11 split graphics presets into individual settings. Earlier options
  // migrations would replace those explicit values with the old preset.
  return mc === '1.21.11' || atLeast(version, '26.1') || atLeast(version, '1.21.12') ? 4671 : undefined;
}

module.exports = { updateOptionDefaults, encodeOptionDefaults, freshOptionsDataVersion };
