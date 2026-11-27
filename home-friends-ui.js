let homeFriendsLayer;
let homeFriendsLoading;
const homeFriendModels = new Map();

function disposeHomeFriendSkins() {
  homeFriendsLayer = undefined;
  for (const model of homeFriendModels.values()) { model.viewer?.dispose(); model.tile.remove(); }
  homeFriendModels.clear();
}

function mountHomeFriendSkins(layer) {
  disposeHomeFriendSkins();
  if (S.showFriendsSkins === false || !layer || !window.skinview3d) return;
  homeFriendsLayer = layer;
  refreshHomeFriendSkins();
}

async function refreshHomeFriendSkins() {
  const layer = homeFriendsLayer;
  if (!layer?.isConnected || homeFriendsLoading === layer || document.hidden) return;
  homeFriendsLoading = layer;
  try {
    const friends = await api.invoke('friends:list');
    if (homeFriendsLayer !== layer || !layer.isConnected) return;
    const online = friends.filter((entry) => entry.accepted && entry.status && /^[A-Za-z0-9_]{3,16}$/.test(entry.name)).slice(0, 4);
    const keep = new Set(online.map((entry) => entry.uid));
    for (const [uid, model] of homeFriendModels) {
      if (!keep.has(uid) || !online.some((entry) => entry.uid === uid && entry.name === model.name)) {
        model.viewer?.dispose(); model.tile.remove(); homeFriendModels.delete(uid);
      }
    }
    for (const [index, entry] of online.entries()) {
      const known = homeFriendModels.get(entry.uid);
      if (known) { known.tile.dataset.position = index; continue; }
      const tile = document.createElement('button');
      tile.type = 'button'; tile.className = 'home-friend-skin'; tile.dataset.position = index;
      tile.title = entry.name + ' · Online';
      tile.setAttribute('aria-label', 'Profil von ' + entry.name);
      tile.onclick = () => showFriendLibrary(entry);
      const label = document.createElement('span'); label.textContent = entry.name;
      const model = { tile, name: entry.name };
      homeFriendModels.set(entry.uid, model);
      try {
        const skin = await api.invoke('mc:skin', { name: entry.name });
        if (homeFriendsLayer !== layer) return;
        if (!skin?.skin) { homeFriendModels.delete(entry.uid); continue; }
        const canvas = document.createElement('canvas');
        tile.append(canvas, label); layer.append(tile);
        const viewer = new skinview3d.SkinViewer({ canvas, width: 105, height: 162 });
        model.viewer = viewer;
        viewer.fov = 45; viewer.zoom = 0.84;
        viewer.controls.enabled = false;
        viewer.camera.position.set(index % 2 === 0 ? -20 : 20, 5, 50);
        viewer.camera.lookAt(0, 0, 0);
        await viewer.loadSkin(skin.skin, { model: skin.slim ? 'slim' : 'default' });
      } catch {
        model.viewer?.dispose(); tile.remove(); homeFriendModels.delete(entry.uid);
      }
    }
  } catch {
    if (homeFriendsLayer === layer) {
      disposeHomeFriendSkins();
      homeFriendsLayer = layer;
    }
  }
  finally { if (homeFriendsLoading === layer) homeFriendsLoading = undefined; }
}

setInterval(refreshHomeFriendSkins, 25000);
api.onFriendChat(() => refreshHomeFriendSkins());
