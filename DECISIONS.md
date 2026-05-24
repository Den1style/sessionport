# SessionPort — База архитектурных решений

> Этот файл — живая документация. Обновляется при каждом значимом изменении.
> Для AI-агентов: читать перед любой правкой кода.

---

## [DEV NOTE] Версионирование — переход на 1.0 (2026-05-24)

При подготовке к первой публикации в Chrome Web Store внутренний счётчик версий (1.2.43)
заменён на публичную версию **1.0**. Изменены три файла:

| Файл | Было | Стало |
|------|------|-------|
| `manifest.json` | `"version": "1.2.43"` | `"1.0"` |
| `content-bundle.js` | `PR_VERSION = '1.2.43'` | `'1.0'` |
| `popup.html` | `<span>v1.2.35</span>` | `v1.0` |

**Что НЕ менялось** (технические внутренние версии):
- `DB_VERSION = 4` — схема IndexedDB (db.js, background.js)
- `PROMPTS_DB_VERSION = 1` — БД промптов (prompts.js)
- `PROTOCOL_VERSION = '1.1'` — формат JSON-снапшота (popup-shell.js)
- `schema_version: 1` — формат экспорта (db.js, background.js)
- `version: '1.2.x'` в adapters.js — даты последней проверки адаптеров LLM

---

## КРИТИЧЕСКИЕ ПРАВИЛА (нарушение = сломанный проект)

### ⚠️ background.js содержит inlined копию db.js
**Проблема:** `background.js` — service worker MV3. Он не может использовать `importScripts` надёжно из-за проблем с перезапуском SW. Поэтому весь код из `db.js` скопирован прямо в начало `background.js`.

**Правило:** При любом изменении `db.js` — синхронизировать `background.js`:
- `DB_VERSION` — в обоих файлах
- `onupgradeneeded` блоки — в обоих файлах
- `saveSnapshot` — в обоих файлах (поля объекта снапшота)
- Новые функции — если нужны в background, добавлять туда тоже

**Последствие нарушения:** Два контекста открывают одну IndexedDB с разными версиями → `VersionError` → `GET_ACTIVE` падает → dropzone disabled → файлы не прикрепляются.

**Обнаружено:** v1.2.39, при добавлении `DB_VERSION=3` и `transfer_id` полей.

---

### ⚠️ IndexedDB: async gaps убивают readwrite транзакцию
**Проблема:** IndexedDB транзакция auto-commits если между двумя requests нет synchronous continuation. `await` создаёт gap → `TransactionInactiveError`.

**Правило:** Никогда не делать несколько `await` внутри одной readwrite транзакции. Все dedup-проверки выполнять **до** открытия транзакции.

**Правильно:**
```js
// Сначала все async проверки
const dup = await getByTransferId(transfer_id);
if (dup) return null;
// Потом транзакция
await wrap(tx('snapshots', 'readwrite').add(snapshot));
```

**Неправильно:**
```js
const transaction = _db.transaction(['snapshots'], 'readwrite');
const dup = await checkTid(); // gap → транзакция закрыта
await checkHash();            // TransactionInactiveError
```

**Обнаружено:** v1.2.39, при попытке сделать единую readwrite транзакцию для dedup+write.

---

## АРХИТЕКТУРА

### Структура файлов
```
manifest.json          # MV3, DB_VERSION не хранится
background.js          # Service Worker = inlined db.js + message handlers
db.js                  # IndexedDB API (popup context)
content-bundle.js      # Единый бандл для content scripts (concat inject+adapters+capture+content)
popup.html             # UI
popup-utils.js         # DOM helpers, transfer_id генерация, sendToContentScript
popup-shell.js         # PROMPTS, роутер экранов, map screen
flow.js                # Логика шагов переноса (Simple/Extended)
files.js               # Dropzone, file list, drag из side panel
history.js             # История снапшотов, diff, фильтры
map-renderer.js        # SVG граф снапшотов (PR_MapRenderer class)
adapters.js            # Per-platform injectors (6 LLM)
shared-utils.js        # PR_Utils (escape, dates, base64, snapToFlowState)
```

### Порядок загрузки скриптов в popup.html
```
db.js → shared-utils.js → map-renderer.js → popup-utils.js →
projects.js → history.js → files.js → flow.js → popup-shell.js
```

### content-bundle.js структура
Четыре блока concat'нуты в один файл (обход MetaMask/Polkadot SES lockdown):
```
// INJECT block   — main world inject helpers
// ADAPTERS block — per-platform LLM adapters
// CAPTURE block  — tryCapture, _saveAndStop, JSON parsing
// CONTENT block  — message handlers, storage listeners
```

---

## TRANSFER_ID АРХИТЕКТУРА (v1.2.38+)

### Цель
Каждая сессия переноса получает UUID (`pr_[a-z0-9]{16}`, 80 бит энтропии).
Модель возвращает его в `meta.transfer_id`. Capture валидирует совпадение.
Устраняет захват чужого JSON со страницы.

### Lifecycle
1. Шаг 1 → `_beginNewTransferSession()` → генерирует UUID → пишет в `flow_state.transfer_id`
2. Шаг 2 → `SET_EXPECTED_TRANSFER_ID` → content-bundle ставит `_expectedTransferId`
3. Capture → `_saveAndStop` → проверяет `parsed.meta.transfer_id === _expectedTransferId`
4. DB → `saveSnapshot` сохраняет `transfer_id` и `parent_transfer_id`

### Distributed chain
- `transfer_id` — UUID текущей сессии (глобально уникален)
- `parent_transfer_id` — UUID предыдущего снапшота (cross-device chain)
- `by_transfer_id` index в IndexedDB — O(log n) lookup
- `getChainByTransferId()` — рекурсивный обход цепочки

### Regex валидация
```js
const TRANSFER_ID_REGEX = /^pr_[a-z0-9]{16}$/;
```

---

## ПЛАТФОРМЫ

### Стратегии вставки файлов
| Платформа | Метод | Статус |
|---|---|---|
| Claude | `input[type=file]` setter + change event | ✅ |
| ChatGPT | `_dropOnly` на форму (Popover API) | ✅ |
| Grok | `input[type=file]` setter (react-dnd) | ✅ |
| Deepseek | `input[type=file]` setter | ✅ |
| Gemini | `ClipboardEvent('paste')` на `.ql-editor` | ✅ v1.2.28 |
| Mistral | `ClipboardEvent('paste')` на `.ProseMirror` | ✅ v1.2.30 |
| Perplexity | `_dragSequence` на `<form>` + Pro warning | ⚠️ Pro only |

### Почему Gemini/Mistral через paste
Angular (`xapfileselectordropzone`) и React проверяют `isTrusted` на drop events и на programmatic `button.click()`. Synthetic DragEvent с `isTrusted=false` отвергается. Но `ClipboardEvent('paste')` с mutable `new DataTransfer()` проходит через Quill/ProseMirror paste handler без проверки isTrusted.

### Strategy 1 fallthrough
`input[type=file]` setter проверяет `inp.files?.length > 0` после dispatch. Если 0 (Perplexity отверг) — падаем в следующую стратегию вместо ложного успеха.

### Cross-window drag (side panel → LLM tab)
1. `dragstart` → `STAGE_DRAG_FILE` → файл в `chrome.storage.local['pr_drag_file_N']`
2. `dragenter` → content-bundle читает staged файлы, армирует main world
3. `drop` → main world достаёт файл из cache → вставляет через platform strategy

---

## ИЗВЕСТНЫЕ ЛОВУШКИ

### saveStep race condition
`saveStep` читает `flow_state` из storage и пишет обратно. Два быстрых клика создают race. Решение: `_saveStepPending` token отменяет предыдущий pending get.

### loadAttachedFiles вызывать только после snapshot_added_at
`flow_state.status = READY_TO_INJECT` пишется из content-script синхронно. `active_snapshot_id` в IndexedDB пишется async через `SAVE_SNAPSHOT` в background. Если вызвать `loadAttachedFiles` сразу по `READY_TO_INJECT` — `GET_ACTIVE` вернёт null. Background пишет `snapshot_added_at` после успешного `setActive` — это надёжный триггер.

### _hmapRenderer.snaps (не _snaps)
В `popup-shell.js` использовать `_mapRenderer.snaps`, не `_mapRenderer._snaps` — поле публичное.

### snapToFlowState должен сохранять transfer_id
При загрузке снапшота из истории `snapToFlowState` должен включать `transfer_id` — иначе `getLastTransferId()` вернёт null и chain оборвётся.

### map-renderer: _hideTooltip в начале _render()
Без этого `mousemove` listener накапливается при каждой перерисовке.

### history.js: параллельные LIST_FILES
При 50+ снапшотах в истории — 50 параллельных `sendMessage`. Решение: `setTimeout(i * 30ms)` между вызовами.

---

## ВЕРСИОННАЯ ИСТОРИЯ

| Версия | Что сделано |
|---|---|
| v1.2.28 | Gemini: synthetic paste на .ql-editor (вместо xap-кнопки) |
| v1.2.29 | Gemini paste применён везде (drop + кнопка вставки) |
| v1.2.30 | Mistral: synthetic paste на .ProseMirror |
| v1.2.31-34 | Perplexity: dragSeq + Pro warning |
| v1.2.35 | Perplexity Pro-friendly (вставляет + предупреждает) |
| v1.2.38 | transfer_id архитектура, DB_VERSION=3, distributed chain |
| v1.2.39 | Синхронизация background.js с db.js (DB_VERSION=3 в обоих), полный аудит: map memory leak, saveStep race, history parent_transfer_id, dropzone race fix |
| v1.2.39-audit | DB_VERSION=4, 10 security/reliability фиксов (см. ниже) |

---

## АУДИТ v1.2.39 — ЛОГ ИЗМЕНЕНИЙ

> 10 фиксов по результатам security/reliability аудита. Все файлы проверены через `node -c`.

### Fix #1 — Atomic saveSnapshot [КРИТИЧЕСКАЯ]
**Файл:** `background.js` saveSnapshot()
**Было:** 3 отдельных readwrite транзакции через `wrap(tx(...))` с `await` между ними. SW kill между ними → inconsistent DB.
**Стало:** Одна `_db.transaction(['snapshots','refs','meta'], 'readwrite')`, три put/add синхронно, Promise через oncomplete/onerror/onabort.

### Fix #2 — listAll projection [СРЕДНЯЯ]
**Файлы:** `background.js`, `db.js` — `listAll()` получил параметр `fields`. `popup-shell.js`, `history.js`, `flow.js` — 5 из 6 call sites переведены на projection.
**Регрессия найдена и исправлена:** mind map `onNodeClick` → `snapToFlowState(snap)` требует `snap.payload`, а projection его убирала. Fix: lazy `getSnapshot(id)` при клике на ноду если `snap.payload` отсутствует.

### Fix #3 — Unique index by_transfer_id [СРЕДНЯЯ]
**Файлы:** `background.js`, `db.js` — DB_VERSION 3→4, миграция `deleteIndex→createIndex({ unique: true })` с safe fallback.
**saveSnapshot:** ConstraintError → return null (atomic dedup). Read-based pre-check оставлен как fast path.
**Нюанс:** IDB не индексирует null значения в unique index — старые снапшоты с `transfer_id: null` не конфликтуют.

### Fix #4 — QuotaExceededError [СРЕДНЯЯ]
**Файл:** `background.js` SAVE_SNAPSHOT handler — проверяет `err.name === 'QuotaExceededError'`, возвращает code `QUOTA_EXCEEDED` и human-readable message.

### Fix #5 — Tab navigation reset [СРЕДНЯЯ]
**Файл:** `background.js` — `chrome.tabs.onRemoved` + `chrome.tabs.onUpdated` сбрасывают `flow_state` из CAPTURING → IDLE при навигации/закрытии LLM-вкладки.

### Fix #6 — Proactive drag GC [СРЕДНЯЯ]
**Файл:** `background.js` — `_gcStaleDragFiles()` на `onInstalled` + `onStartup`. TTL 1ч → 5мин.

### Fix #7 — Payload size limit [СРЕДНЯЯ]
**Файл:** `background.js` saveSnapshot() — `MAX_PAYLOAD_BYTES = 1_000_000`. Reject до sha256.

### Fix #8 — Atomic importAll [СРЕДНЯЯ]
**Файлы:** `background.js`, `db.js` — per-record import → batch: read existing IDs через keyCursor, потом одна tx на все новые записи.

### Fix #9 — esc() quotes [НИЗКАЯ]
**Файл:** `shared-utils.js` — добавлены `"` → `&quot;`, `'` → `&#39;` в esc().

### Fix #10 — WAR cleanup [НИЗКАЯ]
**Файл:** `manifest.json` — убраны test-snapshot.json, test-file.txt из web_accessible_resources. `<all_urls>` → конкретные LLM-домены.

---

## ПРАВИЛО: listAll projection и snapToFlowState

При вызове `listAll` с `fields` (projection) — результат **не содержит payload**. Любая функция, которая вызывает `snapToFlowState(snap)`, должна сначала проверить `snap.payload`:

```js
let fullSnap = snap;
if (!snap.payload && snap.snapshot_id) {
  fullSnap = await SessionPortDB.getSnapshot(snap.snapshot_id);
}
PR_Utils.snapToFlowState(fullSnap);
```

**Правило:** Никогда не передавать projected snap в `snapToFlowState` без lazy load.

---

## ПРАВИЛО: DB_VERSION sync

DB_VERSION теперь **4**. При любом изменении миграции — менять в обоих файлах:
- `background.js` строка 12: `const DB_VERSION = 4;`
- `db.js` строка 18: `const DB_VERSION = 4;`

Миграции должны быть **идемпотентные** (проверять `indexNames.contains` перед createIndex).
