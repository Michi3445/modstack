const fs = require('node:fs');
const files = fs.promises;
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const HOSTS = new Set([
  'piston-meta.mojang.com', 'piston-data.mojang.com', 'launchermeta.mojang.com',
  'launcher.mojang.com', 'libraries.minecraft.net', 'resources.download.minecraft.net',
  'maven.fabricmc.net', 'maven.quiltmc.org',
]);
const PART = /^[\w.+-]+$/;
const SHA1 = /^[a-f0-9]{40}$/i;
const MAX_FILE = 256 * 1024 * 1024;
const validPart = (value) => typeof value === 'string' && PART.test(value) && !/^\.+$|\.$/.test(value);
const keyFor = ({ mc, loader, loaderVersion }) => JSON.stringify([mc, loader, loaderVersion || '']);

function windowsLibrary(library) {
  if (/\bnatives-windows-(?:arm64|x86)$/.test(library.name || '')) return false;
  if (!library.rules) return true;
  let allowed = false;
  for (const rule of library.rules) {
    if (rule.features && Object.values(rule.features).some(Boolean)) continue;
    const platform = rule.os;
    if (platform?.name && platform.name !== 'windows') continue;
    if (platform?.arch && !['x86_64', 'amd64', 'x64'].includes(platform.arch)) continue;
    if (platform?.version && !new RegExp(platform.version).test(os.release())) continue;
    allowed = rule.action === 'allow';
  }
  return allowed;
}

function libraryFiles(libraries) {
  const result = [];
  for (const library of libraries || []) {
    if (!windowsLibrary(library)) continue;
    if (library.downloads) {
      const native = library.natives?.windows?.replace('${arch}', '64');
      for (const item of [library.downloads.artifact, library.downloads.classifiers?.[native]]) {
        if (item?.url) result.push({ ...item, location: 'libraries/' + item.path });
      }
      continue;
    }
    if (!library.url) continue;
    const [group, artifact, version, classifier] = String(library.name).split(':');
    if (!group?.split('.').every(validPart) || ![artifact, version].every(validPart) || (classifier && !validPart(classifier))) continue;
    const relative = group.replace(/\./g, '/') + '/' + artifact + '/' + version + '/' +
      [artifact, version, classifier].filter(Boolean).join('-') + '.jar';
    const url = new URL(relative, library.url).href;
    result.push({ url, sha1: library.sha1, size: library.size, location: 'libraries/' + relative });
  }
  return result;
}

module.exports = function minecraftPreparation({ directory, loader, enabled, notify, concurrency, userAgent }) {
  const jobs = new Map();
  const downloads = new Map();
  let active = false;

  async function request(url, timeout = 15000) {
    const target = URL.parse(url);
    if (target?.protocol !== 'https:' || target.username || target.password || target.port || !HOSTS.has(target.hostname)) {
      throw new Error('Unbekannte Minecraft-Downloadquelle.');
    }
    const response = await fetch(target, { redirect: 'error', headers: { 'User-Agent': userAgent }, signal: AbortSignal.timeout(timeout) });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Minecraft-Download fehlgeschlagen (HTTP ' + response.status + ').');
    }
    return response;
  }

  async function alreadyPresent(destination, size, checksum) {
    const existing = await files.stat(destination).catch(() => null);
    if (!existing?.isFile()) return false;
    if (Number.isSafeInteger(size)) return existing.size === size;
    const hash = createHash('sha1');
    for await (const chunk of fs.createReadStream(destination)) hash.update(chunk);
    return hash.digest('hex') === checksum;
  }

  function download(item) {
    const { location, url, size } = item;
    const segments = location.split('/');
    if (!segments.every(validPart)) throw new Error('Ungültiger Minecraft-Dateipfad.');
    const destination = path.join(directory(), ...segments);
    if (downloads.has(destination)) return downloads.get(destination);
    const pending = (async () => {
      const checksum = String(item.sha1 || (await (await request(url + '.sha1')).text()).trim()).toLowerCase();
      if (!SHA1.test(checksum)) throw new Error('Ungültige Minecraft-Prüfsumme.');
      if (await alreadyPresent(destination, size, checksum)) return;
      const temp = destination + '.' + randomUUID() + '.part';
      try {
        await files.mkdir(path.dirname(destination), { recursive: true });
        const response = await request(url, 90000);
        const hash = createHash('sha1');
        let written = 0;
        await pipeline(Readable.fromWeb(response.body), new Transform({
          transform(chunk, encoding, callback) {
            written += chunk.length;
            if (written > MAX_FILE || (size != null && written > size)) return callback(new Error('Minecraft-Datei ist zu groß.'));
            hash.update(chunk);
            callback(null, chunk);
          },
        }), fs.createWriteStream(temp, { flags: 'wx' }));
        if (hash.digest('hex') !== checksum || (size != null && written !== size)) {
          throw new Error('Prüfsumme einer Minecraft-Datei stimmt nicht.');
        }
        if (!await alreadyPresent(destination, size, checksum)) await files.rename(temp, destination);
      } finally {
        await files.rm(temp, { force: true });
      }
    })().finally(() => downloads.delete(destination));
    downloads.set(destination, pending);
    return pending;
  }

  const read = async (...segments) => JSON.parse((await files.readFile(path.join(directory(), ...segments), 'utf8')).replace(/^\uFEFF/, ''));

  async function vanilla(mc) {
    if (!validPart(mc)) throw new Error('Ungültige Minecraft-Version.');
    const name = mc + '.json';
    const existing = await read('versions', mc, name).catch(() => null);
    if (existing?.id === mc && existing.downloads?.client) return existing;
    const manifest = await (await request(MANIFEST)).json();
    const record = manifest.versions.find((version) => version.id === mc);
    if (!record || !SHA1.test(record.sha1)) throw new Error('Minecraft-Version unbekannt: ' + mc);
    await download({ ...record, location: 'versions/' + mc + '/' + name });
    return read('versions', mc, name);
  }

  function update(job, state, completed = 0, total = 0) {
    job.info = { key: job.key, state, completed, total };
    notify(job.info);
  }

  async function prepare(job) {
    update(job, 'running');
    const { inst } = job;
    const version = await vanilla(inst.mc);
    const index = version.assetIndex;
    if (!validPart(index?.id)) throw new Error('Minecraft-Ressourcenindex fehlt.');
    const indexFile = index.id + '.json';
    await download({ ...index, location: 'assets/indexes/' + indexFile });
    const resources = await read('assets', 'indexes', indexFile);
    const base = [
      { ...version.downloads.client, location: 'versions/' + inst.mc + '/' + inst.mc + '.jar' },
      ...libraryFiles(version.libraries),
    ];
    const log = version.logging?.client?.file;
    if (log) base.push({ ...log, location: 'assets/log_configs/' + log.id });
    for (const { hash, size } of Object.values(resources.objects)) {
      if (!SHA1.test(hash)) throw new Error('Ungültige Minecraft-Ressource.');
      const relative = hash.slice(0, 2) + '/' + hash;
      base.push({ sha1: hash, size, url: 'https://resources.download.minecraft.net/' + relative, location: 'assets/objects/' + relative });
    }
    // Move base game files into the launcher cache even when loader metadata is unavailable.
    let loaderId;
    let loaderError;
    if (['fabric', 'quilt'].includes(inst.loader)) {
      try {
        loaderId = await loader(inst);
        base.push(...libraryFiles((await read('versions', loaderId, loaderId + '.json')).libraries));
      } catch (error) { loaderError = error; }
    }
    const queue = [...new Map(base.map((item) => [item.location, item])).values()];
    let current = 0, complete = 0, lastReport = 0;
    const errors = [];
    await Promise.all(Array.from({ length: Math.min(6, concurrency()) }, async () => {
      while (current < queue.length) {
        const item = queue[current++];
        try { await download(item); }
        catch {
          try { await download(item); } catch (error) { errors.push(error); }
        }
        if (++complete === queue.length || Date.now() - lastReport >= 350) {
          lastReport = Date.now();
          update(job, 'running', complete, queue.length);
        }
      }
    }));
    if (errors.length || loaderError) throw errors[0] || loaderError;
    update(job, 'ready', queue.length, queue.length);
    return loaderId;
  }

  async function runQueue() {
    if (active) return;
    active = true;
    try {
      for (const job of jobs.values()) {
        if (job.info.state !== 'queued') continue;
        if (!enabled()) { update(job, 'idle'); job.resolve(); continue; }
        try { job.resolve(await prepare(job)); }
        catch { update(job, 'failed'); job.resolve(); }
      }
    } finally { active = false; }
  }

  function schedule(inst, retry = false) {
    const key = keyFor(inst);
    const existing = jobs.get(key);
    if (!enabled()) return { key, state: 'idle' };
    if (existing && existing.info.state !== 'idle' && !(retry && existing.info.state === 'failed')) return existing.info;
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    const job = { key, inst: { ...inst }, promise, resolve };
    jobs.set(key, job);
    update(job, 'queued');
    void runQueue();
    return job.info;
  }

  return {
    vanilla,
    schedule,
    async beforePlay(inst) {
      const job = jobs.get(keyFor(inst));
      if (job?.info.state === 'running' || job?.info.state === 'ready') return job.promise;
      if (job?.info.state === 'queued') { update(job, 'idle'); job.resolve(); }
    },
  };
};
