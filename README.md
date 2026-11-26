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
npx @electron/packager . Modstack --platform=win32 --arch=x64 --ignore='\.log$'
```

Personal, non-commercial project.

## Friends

Modstack uses Firebase Authentication with Email/Password and Firebase Realtime Database.
Publish `firebase-friends.rules.json` in the Realtime Database rules editor for a new database.
If a database already has rules, merge the `modstackFriends` branch into them and keep access
restricted at the database root so the branch rules can enforce membership.
The desktop app ships with the public Firebase Web App configuration in `friends-project.json`.
Use **Freunde → Firebase ändern** while signed out to connect a different project.
Accepted friends can message each other, set a profile picture, and share importable
Modrinth-based instances in the chat. The **Geteilt** tab can browse older shared packs.
Online and active-pack visibility are optional and limited to accepted friends.
An Essential card shares the pack and host name. Send and accept the actual world
invitation in Essential. Server cards share the unmodified Minecraft server address.
Sharing uses the Modstack code format. For local files or mod configuration, use the separate
`.mrpack` export. Publish the current rules file before enabling chat in a Firebase project.

## Windows app updates

The portable Windows x64 app checks for signed GitHub releases at startup and under
**Optionen → Updates**. Firebase can announce a version at `modstackUpdates/windows-x64`
as a string such as `"1.11.0"`. Only an administrator can change the announcement.
If the announcement is missing or inaccessible, Modstack checks the latest GitHub release.
Windows runtime updates keep the previous program folder beside the updated app.
App updates download in the background and install when closing Modstack. This can
be disabled under **Optionen → Updates**.

For a release, bump the app version, package the Windows build, and ZIP the
`Modstack-win32-x64` directory including its directory name. Run
`node scripts/prepare-update.js <Modstack-win32-x64> <Modstack-win.zip> <output-dir>`
and upload the generated files to the matching GitHub tag, for example `v1.11.0`.
Use `--full-only` when Windows files outside `resources/app.asar` have changed
without a change to the Electron version. Use a fresh output directory for each release.

The signing script uses the private Ed25519 key at
`%LOCALAPPDATA%\ModstackRelease\update-signing-key.pem` or the file specified in
`MODSTACK_SIGNING_KEY`. Back up the private key securely and keep it out of Git and release assets.
