<p align="center">
  <img src="icons/icon128.png" width="96" alt="SessionPort" />
</p>

# SessionPort v1.0 — Chrome Extension

Transfer conversation context between AI platforms without external APIs.  
Supports Claude, ChatGPT, Grok, Gemini, Mistral, DeepSeek, Perplexity.

## Features

- **Simple transfer** (2 steps) — model generates a JSON snapshot automatically
- **Advanced transfer** (3 steps) — anchor validation + clarifying questions
- **Prompt Library** — write once, insert everywhere across all 7 platforms; supports `{{variables}}`, tags, file attachments
- **File drag & drop** — from side panel into any LLM chat
- **Mind map** — visual snapshot graph with navigation
- **Distributed chain** — `transfer_id` links snapshots across devices
- **History** — search, project filters, diff between snapshots
- **Google Drive backup** — optional cloud backup for snapshots
- **9 languages** — en, ru, de, fr, es, ja, ko, zh, pt

## Install (developer mode)

1. Download the [latest release](https://github.com/Den1style/sessionport/releases/latest) and unzip
2. Open `chrome://extensions/`
3. Enable **Developer mode**
4. Click **Load unpacked** → select the unzipped folder

## Architecture

```
background.js        Service Worker
db.js                IndexedDB API (popup context)
content-bundle.js    Content scripts (isolated world)
main-world-inject.js MAIN world inject (Gemini/Mistral)
popup.html           Side panel UI
popup-shell.js       UI components and screens
popup-utils.js       UI utilities
flow.js              Transfer steps
capture.js           Snapshot capture
adapters.js          Per-platform LLM adapters
inject.js            Page injection
files.js             Dropzone + drag out
history.js           History + diff
map-renderer.js      SVG graph
settings.js          Settings
projects.js          Projects
prompts.js           Prompt Library
dashboard.js         Dashboard (full-page view)
google-drive.js      Google Drive backup
trash.js             Trash
shared-utils.js      PR_Utils
i18n.js              Localization (9 languages)
```

## Storage

IndexedDB `SessionPort_v1`, DB_VERSION = 4.  
Stores: snapshots, refs, meta, blobs, snapshot_files.

## License

Source-available under [Elastic License 2.0](https://www.elastic.co/licensing/elastic-license).
