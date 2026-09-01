# Run McBopomofo JS on MacishType

MacishType is a macOS input method that loads JavaScript engines from a
user-picked folder. This output folder ships McBopomofo as one such
engine.

## Build and Run

- Install MacishType from https://github.com/luke-chang/MacishType
  (follow the install instructions in that repo's README).
- Run `npm run build:macishtype` from the McBopomofoWeb repo root. The
  command writes `index.js` and `McBopomofo.js` into this folder.
- Open **System Settings → Keyboard → Input Sources** and add **JS** —
  MacishType registers several input sources; **JS** is the one that
  loads external engines from a user-picked folder.
- Open MacishType's **Settings → JS → Engine folder → Choose Folder…**
  and point it at this `output/macishtype` folder. MacishType reloads
  automatically when files inside change.
- Switch the active input method to MacishType and start typing.

## Dictionaries

User phrases and excluded phrases live under `_storage/` as plain text
files. Edit them in Finder or vim and the engine reloads on save.

## Debug

- Run `make log-js` from the MacishType repo to stream the engine's
  `console.log` output (bridges to macOS `OSLog`).
- Console.app filter: `subsystem:net.lukechang.inputmethod.MacishType
  category:JavaScript`.
- After editing the bundle, MacishType picks it up on the next text-field
  focus — no relaunch needed.
