let watchedPreparation;
let preparationRequest = 0;

function showMinecraftPreparation(info) {
  const badge = document.querySelector('#mcPreparation');
  if (info.key !== watchedPreparation || S.prepareMinecraft === false) return;
  badge.hidden = info.state === 'idle';
  badge.disabled = info.state !== 'failed';
  const progress = info.total ? ' · ' + Math.floor(100 * info.completed / info.total) + ' %' : '';
  badge.textContent = {
    queued: 'Minecraft-Download in Warteschlange',
    running: 'Minecraft lädt im Hintergrund' + progress,
    ready: 'Minecraft-Dateien bereit',
    failed: 'Download erneut versuchen',
  }[info.state] || '';
}

function watchMinecraftPreparation(instance, retry = false) {
  const key = instance && S.prepareMinecraft !== false
    ? JSON.stringify([instance.mc, instance.loader, instance.loaderVersion || '']) : undefined;
  if (watchedPreparation === key && !retry) return;
  watchedPreparation = key;
  const request = ++preparationRequest;
  document.querySelector('#mcPreparation').hidden = true;
  if (!key) return;
  api.invoke('mc:prepare', { id: instance.id, retry }).then((info) => {
    if (request === preparationRequest) showMinecraftPreparation(info);
  }).catch(() => {});
}

api.onMinecraftPreparation(showMinecraftPreparation);
