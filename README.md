# Modstack

A lightweight Minecraft mod manager for Windows, built with Electron.

## Features

- Create instances with a Minecraft version and loader (Fabric, Forge, NeoForge, Quilt)
- Search and install mods from Modrinth, including required dependencies
- Check for and install mod updates
- Add your own `.jar` files by drag and drop
- Import CurseForge profiles via share code or exported `.zip`
- Play through the official Minecraft Launcher (Modstack writes a launcher profile per instance)

## Build

```
npm install
npx @electron/packager . Modstack --platform=win32 --arch=x64
```

Personal, non-commercial project.
