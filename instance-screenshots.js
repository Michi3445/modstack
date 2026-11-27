const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { canonicalScreenshot } = require('./screenshot-codec');

const IMAGE = /^[^<>:"/\\|?*\x00-\x1f]{1,180}\.(?:png|jpe?g|webp)$/i;
const CACHE = /^[a-f\d]{64}\.jpg$/;

module.exports = function instanceScreenshots({ ipc, instDir, readInst, cache, settings, nativeImage, clipboard, shell }) {
  function folder(id) {
    if (settings().screenshotsEnabled === false) throw new Error('Die Screenshot-Galerie ist in den Optionen ausgeschaltet.');
    if (typeof id !== 'string' || !id || id === '.' || id === '..' || /[\\/:]/.test(id) || readInst(id).id !== id) {
      throw new Error('Ungültige Instanz.');
    }
    const instance = instDir(id);
    const dir = path.join(instance, 'screenshots');
    if ([instance, dir].some((target) => fs.lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink())) {
      throw new Error('Verknüpfte Screenshot-Ordner werden nicht verwendet.');
    }
    return dir;
  }

  function imageAt(dir, name) {
    if (typeof name !== 'string' || !IMAGE.test(name)) return null;
    const file = path.join(dir, name);
    const info = fs.lstatSync(file, { throwIfNoEntry: false });
    return info?.isFile() && info.size > 0 && info.size <= 64 * 1024 * 1024 ? { file, info } : null;
  }

  function imageTarget({ id, name }) {
    const target = imageAt(folder(id), name);
    if (!target) throw new Error('Der Screenshot ist nicht mehr verfügbar.');
    return target;
  }

  function view(name, max) {
    const source = nativeImage.createFromPath(name);
    if (source.isEmpty()) throw new Error('Der Screenshot konnte nicht gelesen werden.');
    if (!max) return source;
    const { width, height } = source.getSize();
    return Math.max(width, height) <= max ? source : source.resize(width >= height ? { width: max } : { height: max });
  }

  let cacheWrites = 0;
  async function thumbnail(args) {
    const { file, info } = imageTarget(args);
    const key = createHash('sha256').update(JSON.stringify([file, info.mtimeMs, info.size])).digest('hex');
    const cached = path.join(cache, key + '.jpg');
    const safeCache = !fs.lstatSync(cache, { throwIfNoEntry: false })?.isSymbolicLink();
    if (safeCache && fs.lstatSync(cached, { throwIfNoEntry: false })?.isFile()) {
      return 'data:image/jpeg;base64,' + fs.readFileSync(cached).toString('base64');
    }
    let source;
    try { source = await nativeImage.createThumbnailFromPath(file, { width: 400, height: 250 }); }
    catch { source = view(file, 400); }
    if (source.isEmpty()) source = view(file, 400);
    const jpeg = source.toJPEG(78);
    if (safeCache) {
      try {
        fs.mkdirSync(cache, { recursive: true });
        fs.writeFileSync(cached, jpeg, { flag: 'wx' });
        if (++cacheWrites % 40 === 0) {
          const entries = fs.readdirSync(cache, { withFileTypes: true }).filter((item) => item.isFile() && CACHE.test(item.name));
          const paths = entries.map((item) => path.join(cache, item.name));
          paths.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
          for (const old of paths.slice(700)) fs.rmSync(old, { force: true });
        }
      } catch {}
    }
    return 'data:image/jpeg;base64,' + jpeg.toString('base64');
  }

  ipc.handle('screenshots:list', (id) => {
    const dir = folder(id);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).flatMap((name) => {
      const target = imageAt(dir, name);
      return target ? [{ name, at: target.info.mtimeMs, size: target.info.size }] : [];
    }).sort((a, b) => b.at - a.at || b.name.localeCompare(a.name, 'de'));
  });
  ipc.handle('screenshots:thumbnail', thumbnail);
  ipc.handle('screenshots:chatPayload', (value) => {
    const data = canonicalScreenshot(value);
    if (!data) throw new Error('Das Bild konnte nicht für den Chat vorbereitet werden.');
    return data;
  });
  ipc.handle('screenshots:view', (args) => view(imageTarget(args).file, 2200).toDataURL());
  ipc.handle('screenshots:shareSource', (args) => view(imageTarget(args).file, 800).toDataURL());
  ipc.handle('screenshots:copy', (args) => { clipboard.writeImage(view(imageTarget(args).file)); });
  ipc.handle('screenshots:reveal', (args) => { shell.showItemInFolder(imageTarget(args).file); });
  ipc.handle('screenshots:remove', (args) => { fs.unlinkSync(imageTarget(args).file); });
};
