# Modstack

A lightweight Minecraft mod manager for Windows, built with Electron.

## Features

- Create instances with a Minecraft version and loader (Fabric, Forge, NeoForge, Quilt)
- Search and install mods, resource packs and shaders from Modrinth (mods include required dependencies)
- Browse and install Modrinth modpacks, or import `.mrpack` files
- Enable/disable mods without deleting them
- Check for and install updates; check for known incompatibilities and missing dependencies
- Per-instance RAM and Java arguments, duplicate and rename instances
- Add your own `.jar`/`.zip` files by drag and drop (matched to Modrinth automatically when possible)
- Import CurseForge profiles via share code or exported `.zip`
- Play through the official Minecraft Launcher (Modstack writes a launcher profile per instance)

## Build

```
npm install
npx @electron/packager . Modstack --platform=win32 --arch=x64
```

Personal, non-commercial project.
