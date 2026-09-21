# dsh-file-menu

Right-click menus for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) Web UI.

The DSH Web client ships no `contextmenu` handler, so right-clicking inside the app does nothing useful — no copy,
no paste, no "open file location". This plugin adds a Codex-style menu that fits whatever you clicked.

English | [简体中文](README.zh.md)

## Features

The menu is built from the element under the cursor:

| Right-click target | Menu rows |
|---|---|
| Selected text | Copy |
| A paragraph (no selection) | Copy this paragraph |
| Input box / editable area | Cut · Copy · Paste · Select all |
| A file reference (delivered-file card, produced-file chip, inline file mention) | Copy path · **Reveal in file manager** · Open with default app |
| A link | Copy link address · Open in browser |
| Alt + right-click | Diagnostics: copy element info |

- **Copy** goes through the host route `/file-menu/clipboard` (Electron main-process clipboard, falling back to
  PowerShell `Set-Clipboard`) instead of relying on the renderer's clipboard permission. If the host route is
  unavailable, the client falls back to `document.execCommand('copy')`.
- **Reveal in file manager** selects the file where the OS supports it — Windows Explorer `/select`, macOS Finder
  `open -R`. On Linux `xdg-open` has no "select" concept, so the containing directory is opened instead. If the host
  route is missing entirely, the client falls back to DSH's own `/open-in-app/open`.
- File paths are read from the element's `title`, `data-path`, `data-file-path`, `dataset.*path`, or the selected text.
  Only absolute paths (`C:\...`, `\\server\...`, `/...`) are accepted.

## Install

```sh
dsh plugin --profile web add dsh-file-menu
```

Use the profile you actually run (`web` for the Web client, your own profile name for DSH Desktop). Restart DSH after
installing.

## Uninstall

```sh
dsh plugin --profile web remove dsh-file-menu
```

## Limits

- Paths that DSH renders as plain text are not recognized — only elements carrying an absolute path in a
  `title`/`data-path` attribute, or a selected path string.
- Only absolute paths are accepted; the host routes reject anything else.
- The two halves version independently: the client (`lib/client.js`) is versioned with the package, while the host half
  reports its own version from `GET /file-menu/status`.

## How it works

- **Host half** `lib/index.js` — a `webServer` prefix route `/file-menu` serving
  `ping`, `status`, `hello`, `menu`, `diag`, `clipboard`, `reveal` and `open`; absolute-path validation only.
- **Client half** `lib/client.js` — a capture-phase `contextmenu` handler plus a plain-DOM menu (no React dependency),
  with `pointerdown` + `elementFromPoint` activation so an upstream `stopPropagation` cannot swallow the click.
- `cordis.patch.yml` — the single bundle row that registers the host half. The client bundle is served automatically
  because the host entry declares `dsh.client`.

Maintainer notes — HMR pitfalls, event-swallowing, debugging without a browser console — are in
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## License

MIT
