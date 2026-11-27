const fs = require('node:fs');
const path = require('node:path');
const { createHash, createPrivateKey, sign, verify } = require('node:crypto');
const { execFileSync } = require('node:child_process');

const VERSION = /^(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5})$/;

async function fileRecord(file, name, max) {
  const size = fs.statSync(file).size;
  if (!size || size > max * 1024 * 1024) throw new Error('Dateigröße außerhalb der erlaubten Grenzen: ' + name);
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return { name, size, sha256: hash.digest('hex') };
}

async function main() {
  const [appDir, zip, output, option] = process.argv.slice(2);
  if (!appDir || !zip || !output || (option && option !== '--full-only')) {
    throw new Error('Aufruf: node scripts/prepare-update.js <Modstack-Ordner> <Windows-ZIP> <Ausgabeordner> [--full-only]');
  }
  const asar = path.join(appDir, 'resources', 'app.asar');
  const { extractFile, listPackage } = await import('@electron/asar');
  const privateFile = listPackage(asar).find((name) =>
    /(?:\.log$|[\\/](?:\.env(?:\.[^\\/]+)?|update-signing-key\.pem|launcher_accounts[^\\/]*\.json|friends-session))$/i.test(name));
  if (privateFile) throw new Error('Die Windows-App enthält eine lokale Datei: ' + path.basename(privateFile));
  const { version } = JSON.parse(extractFile(asar, 'package.json').toString('utf8'));
  const notes = JSON.parse(extractFile(asar, 'patch-notes.json').toString('utf8'));
  if (notes.version !== version || !Array.isArray(notes.changes) || !notes.changes.length ||
      notes.changes.some((change) => !change || typeof change.title !== 'string' || !change.title.trim() ||
        typeof change.text !== 'string' || !change.text.trim())) {
    throw new Error('Patchnotes für diese App-Version fehlen oder sind unvollständig.');
  }
  const electron = fs.readFileSync(path.join(appDir, 'version'), 'utf8').trim();
  if (!VERSION.test(version) || version !== require('../package.json').version || !VERSION.test(electron)) {
    throw new Error('Versionen der Windows-App prüfen.');
  }
  const app = await fileRecord(asar, 'Modstack-app.asar', 128);
  const full = await fileRecord(zip, 'Modstack-win.zip', 600);
  const readZipFile = (name, maxBuffer) =>
    execFileSync('tar.exe', ['-xOf', path.resolve(zip), 'Modstack-win32-x64/' + name], { windowsHide: true, maxBuffer });
  if (createHash('sha256').update(readZipFile('resources/app.asar', 128 * 1024 * 1024)).digest('hex') !== app.sha256 ||
      readZipFile('version', 1024).toString('utf8').trim() !== electron) throw new Error('ZIP und Windows-Build stimmen nicht überein.');
  const payload = Buffer.from(JSON.stringify({
    format: 1, platform: 'win32-x64', version, electron, assets: { full, ...(option ? {} : { asar: app }) },
  }));
  const keyPath = process.env.MODSTACK_SIGNING_KEY || path.join(process.env.LOCALAPPDATA, 'ModstackRelease', 'update-signing-key.pem');
  const privateKey = createPrivateKey(fs.readFileSync(keyPath));
  const publicKey = fs.readFileSync(path.join(__dirname, '..', 'update-public.pem'));
  const signature = sign(null, payload, privateKey);
  if (!verify(null, payload, publicKey, signature)) throw new Error('Der Signaturschlüssel passt nicht zu Modstack.');

  fs.mkdirSync(output, { recursive: true });
  fs.copyFileSync(zip, path.join(output, full.name));
  if (!option) fs.copyFileSync(asar, path.join(output, app.name));
  fs.writeFileSync(path.join(output, 'modstack-update.json'), JSON.stringify({
    payload: payload.toString('base64url'), signature: signature.toString('base64url'),
  }, null, 2) + '\n');
  console.log('Signiertes Modstack-Release v' + version + ' erstellt.');
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
