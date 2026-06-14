# SessionPort — Changelog

> Хронология всех значимых изменений. Самое свежее — сверху.

---

## [v1.1] — В разработке

### Запланировано
- **Синхронизация между устройствами** — автосинхронизация снапшотов через Google Account. Войдите один раз — снапшоты будут доступны на всех ваших браузерах и устройствах в реальном времени.
- Расширенная аутентификация Google (профиль, история переносов в облаке)
- Заглушка UI доступна уже сейчас в разделе «Аккаунт» (значок человека → вкладка Аккаунт)

---

## [v1.0.4] — 2026-06-14

### Промпт восстановления доведён до уровня генерации

Развитие v1.0.3: теперь промпт восстановления так же продуман, как промпты создания снапшота (формат снапшота не менялся — всё обратно совместимо).

- **Промпт восстановления на всех 9 языках.** Раньше при вставке контекста инструкции восстановления были только на русском (content-scripts) или русском/английском (попап) — независимо от выбранного языка интерфейса. Теперь промпт восстановления локализован на те же 9 языков, что и генерация (en, ru, de, fr, es, zh, ja, ko, pt). Источник языка — `_lang` / `PR_i18n.lang`.
- **Защита от выдумывания при восстановлении** (симметрично правилу «не придумывай» на стороне генерации): «опирайся только на данные слепка; если для следующего шага чего-то не хватает — спроси, не выдумывай».
- **Подтверждение-ориентир перед работой**: модель сначала одной строкой подтверждает «цель + следующий шаг», и только потом отвечает на `validation.questions` и продолжает. Пользователь мгновенно видит, корректно ли лёг перенос, ещё до того как модель потратит ход на неверное продолжение.
- **`trajectory` теперь читается при восстановлении** (куда движется проект) — раньше поле генерировалось, но в инструкции восстановления не упоминалось.
- **Реальная дата вместо `YYYY-MM-DD`.** В шаблон генерации подставляется сегодняшняя дата в `meta.date`, чтобы модель копировала её, а не галлюцинировала.

---

## [v1.0.3] — 2026-06-13

### Улучшение логики промптов переноса

Доработаны промпты простого и расширенного переноса (формат снапшота не менялся — все правки обратно совместимы):

- **Исправлено принудительное «≥2 отклонения»** во всех локалях (8 из 9 языков навязывали минимум 2 `type:"rejected"`, что заставляло модель выдумывать отказы и противоречило правилу «не придумывай»). Теперь: включить ВСЕ реальные отклонения, а если их не было — массив может быть пустым.
- **Простой перенос, шаг 2** теперь преобразует уже проверенный пользователем разбор шага 1 в JSON один-в-один, а не анализирует переписку заново (убирает расхождение с тем, что человек вычитал).
- **Поведенческая валидация**: `validation.questions` теперь проверяют реальные решения и отклонённые варианты, чтобы неверное восстановление давало заметно ошибочный ответ, а не тривиальный пересказ `dna.goal`.
- **Новое поле `open_threads[]`** в схеме — реально нерешённые вопросы и открытые ветки (то, что обсуждали, но не закрыли).
- **Промпт восстановления** теперь учитывает уверенность допущений (low → уточнить, medium → действовать с пометкой, high → принять), соблюдает `adaptation_log` (не предлагать заново отклонённое) и держит `open_threads` как живые задачи.

---

## [v1.0] — 2026-05-24

### Первый публичный релиз

**Перенос контекста между LLM** без внешних API: Claude, ChatGPT, Grok, Gemini, Mistral, Deepseek, Perplexity.

Ключевые возможности релиза:
- Простой (1 шаг) и расширенный (3 шага) перенос контекста
- Прикрепление файлов drag & drop из side panel в чат
- Mind map — SVG-граф снапшотов с навигацией и zoom
- История с поиском, фильтрами по проекту, мягким удалением (корзина)
- Google Drive бэкап с автобэкапом по расписанию
- Экспорт / импорт снапшотов (JSON)
- Темы dark/light, 9 языков интерфейса
- Transfer ID для связи снапшотов между устройствами (distributed chain)
- Spotlight-онбординг для новых пользователей

> Подробный dev-трек v1.2.x задокументирован ниже.

---

## [v1.2.43] — 2026-05-12

### Безопасность
- **[НИЗ] XSS в file-icon label** — `ic.label` в `renderFiles()` и `loadHistCardFiles()` в `files.js` обёрнут `PR_Utils.esc()`. Имя файла с расширением вида `<SCR` могло попасть в innerHTML без экранирования (4-char limit делал реальную эксплуатацию практически невозможной, но исправлено для корректности).

### Надёжность (chrome-extension-performance: api-handle-context-invalidated)
- **safeSendMessage wrapper** — добавлен в `inject.js` и синхронизирован в `content-bundle.js`. Перехватывает "Extension context invalidated" при вызове chrome.runtime.* после обновления расширения. Устраняет необработанные исключения в content scripts при горячей перезагрузке.
- **setBadge guard** — `setBadge()` теперь проверяет `chrome.runtime?.id` и оборачивает sendMessage в try-catch. Ранее: ошибка "Extension context invalidated" при обновлении во время захвата.
- **SAVE_SNAPSHOT через safeSendMessage** — `_saveAndStop()` в `capture.js` и CAPTURE-блоке `content-bundle.js` использует safeSendMessage вместо прямого sendMessage. Добавлена обработка QUOTA_EXCEEDED с toast.
- **INIT guard** — инициализация content-bundle.js (сброс зависших CAPTURING сессий) и `storage.onChanged` listener проверяют `chrome.runtime?.id` перед chrome API вызовами.
- **PR_VERSION sync** — `content-bundle.js` обновлён с `1.2.39` до `1.2.42`.

### Производительность (chrome-extension-ux: ui-batch-badge-updates)
- **Promise.all для badge** — в `background.js` SAVE_SNAPSHOT handler `setBadgeText` + `setBadgeBackgroundColor` теперь вызываются параллельно через `Promise.all`.

### Доступность (chrome-extension-ux: access-aria-labels)
- **aria-label на icon-only кнопках** — добавлены `aria-label` для: `btnAccount`, `projRenameBtn`, `projChevronBtn`, `btnResetFlow`, zoom-кнопки обоих Mind Map экранов (6 кнопок).

---

## [v1.2.42] — 2026-05-11

### Безопасность
- **[КРИТ] XSS в tooltip map-renderer** — `snap.project`, `source_host`, `target_host` в tooltip innerHTML обёрнуты `PR_Utils.esc()`. Вредоносный project name из LLM мог выполнить JS.
- **[СРЕД] sender.id проверка** — `background.js` onMessage теперь отклоняет сообщения с `sender.id !== chrome.runtime.id`, блокируя потенциальные межрасширенческие инъекции.
- **[НИЗ] console.log cleanup** — убраны `console.log` из `main-world-inject.js` (раскрывали dragId, filename, armedFiles) и `capture.js` (snapshot_id). `background.js` GC лог удалён.

### MV3 / Service Worker
- **chrome.alarms для badge clear** — `setTimeout(4000)` в SW заменён на `chrome.alarms.create('pr_badge_clear')`. SW мог завершиться до истечения таймера — теперь badge очищается надёжно.
- **Периодический GC через alarms** — `chrome.alarms.create('pr_gc', {periodInMinutes: 30})` в `onInstalled`. Drag-файлы очищаются каждые 30 минут, не только при старте.

### SVG Performance (map-renderer.js)
- **RAF throttle на pan/drag render** — `_render()` при pan, node drag и group drag теперь вызывается через `requestAnimationFrame`. Устраняет избыточные перерисовки при быстром перемещении (было: render на каждый px mousemove).
- **RAF throttle на tooltip mousemove** — позиция tooltip обновляется через `requestAnimationFrame`.
- **destroy() метод** — `PR_MapRenderer.destroy()` снимает `window.addEventListener('mousemove')` и `mouseup` обработчики, предотвращая накопление при переключении экранов.

### CWS / Manifest
- Manifest version: 1.2.39 → **1.2.42**
- Name: убран test-маркер `[CPGE · MD-test]` → `SessionPort`
- Description: заменён dev-note на user-facing описание
- Добавлен `alarms` permission (требуется для pr_badge_clear + pr_gc)

---

## [v1.2.41] — 2026-05-10

### Добавлено
- **Поиск по истории** — live-фильтрация по project, source_host, target_host; счётчик badge обновляется по результатам поиска
- **Выбор узла в обоих Mind Map** — клик по узлу → пунктирное кольцо выделения + info panel под картой (проект, хост, дата, KB); кнопка «Загрузить слепок» в панели загружает и переходит на главный экран
- **Выбор карточки в истории** — клик по телу карточки выделяет её (фиолетовая рамка); пре-выбирает соответствующий узел в map, чтобы при переключении на вкладку Map кольцо уже было

### Исправлено
- **Критический баг: клики по узлам Mind Map не работали** — SVG имел `pointer-events:none`, блокируя все события на circle-элементах; изменено на `pointer-events:all`; tooltip на hover теперь тоже корректно работает

---

## [v1.2.40] — 2026-05-10

### Добавлено
- **Корзина (Trash screen)** — мягкое удаление снапшотов через `deleted_at` поле; восстановление и перманентное удаление; кнопка «Очистить корзину»; красный бэдж с счётчиком на кнопке навигации
- **Настройки (Settings screen)** — двухвкладочный экран: «Аккаунт» (заглушка формы входа + Google) и «Настройки» (переключение темы); переиспользует CSS-паттерн `.trans-tab`
- **Иконка аккаунта** — фиксированная кнопка `position:fixed; top:10px; right:10px` с силуэтом человека, видна на всех экранах
- **Кнопка удаления в карточке истории** — всегда видима (не только при hover), в правом верхнем углу карточки

### Улучшено — дизайн
- CSS-переменные `--border` и `--border-accent` для унификации границ
- `:focus-visible` — зелёный outline `#aaff00` вместо дефолтного синего
- `-webkit-font-smoothing: antialiased` — более чёткий рендеринг шрифтов
- Glow на `#aaff00` элементах: логотип, progress bar, proj-dot, dropzone
- `box-shadow` на секциях, карточках истории, `is-head` карточке
- Плавные переходы (`transition: 0.15s`) на навигации, proj-bar, bug-link, hist-paste-btn
- Font-weight и font-size уточнены: заголовок секции 500→600, версия 10→11px, описание 11→12px
- Light mode background: `#f8f9fa` → `#f8f9fc` (tinted white)

### Технически
- `db.js` — добавлены: `softDelete()`, `restoreSnapshot()`, `permanentDelete()`, `listTrashed()`
- `db.js` — `listAll()` получил `includeTrashed: false` по умолчанию
- `history.js` — делегирование клика на `[data-soft-delete]`
- Новые файлы: `trash.js`, `settings.js`
- `popup-shell.js` — расширен SCREENS[], добавлены роутинг на trash/settings, listener'ы btnAccount/btnTrash/btnSettings

---

## [v1.2.39-audit] — 2026 (до мая)

### 10 фиксов по результатам security/reliability аудита

- **[КРИТ] Atomic saveSnapshot** — одна readwrite транзакция вместо трёх последовательных `await`; устранён риск inconsistent DB при kill SW между записями
- **[СРЕД] listAll projection** — параметр `fields` для выборки нужных полей; снижение расхода памяти при 50+ снапшотах; lazy-load `payload` в `snapToFlowState`
- **[СРЕД] Unique index by_transfer_id** — DB_VERSION 3→4; ConstraintError → return null (atomic dedup); старые снапшоты с `null` не конфликтуют
- **[СРЕД] QuotaExceededError** — SAVE_SNAPSHOT handler возвращает `QUOTA_EXCEEDED` вместо немого падения
- **[СРЕД] Tab navigation reset** — `chrome.tabs.onRemoved` + `onUpdated` сбрасывают `flow_state` CAPTURING→IDLE при уходе со страницы LLM
- **[СРЕД] Drag GC** — `_gcStaleDragFiles()` при onInstalled + onStartup; TTL сокращён с 1ч до 5 мин
- **[СРЕД] Payload size limit** — `MAX_PAYLOAD_BYTES = 1_000_000`; reject до sha256
- **[СРЕД] Atomic importAll** — batch-запись новых записей в одну транзакцию вместо per-record
- **[НИЗ] esc() quotes** — экранирование `"` → `&quot;`, `'` → `&#39;`
- **[НИЗ] manifest WAR cleanup** — убраны test-файлы; `<all_urls>` заменён на конкретные LLM-домены

---

## [v1.2.39] — 2026 (до мая)

### Исправлено
- Синхронизация `background.js` с `db.js` (DB_VERSION=3 в обоих файлах) — устранён `VersionError` при двух контекстах на одной IndexedDB
- Memory leak в map-renderer: `_hideTooltip` в начале `_render()` — mousemove listener больше не накапливается
- `saveStep` race condition: `_saveStepPending` token отменяет предыдущий pending read
- `history.js`: `parent_transfer_id` теперь корректно сохраняется в chain
- Dropzone race: надёжная очерёдность через `snapshot_added_at` триггер

---

## [v1.2.38] — 2026 (до мая)

### Добавлено
- **Transfer ID архитектура** — каждая сессия получает UUID `pr_[a-z0-9]{16}` (80 бит энтропии)
- **Distributed chain** — `transfer_id` + `parent_transfer_id`; `getChainByTransferId()` для кросс-девайс цепочки
- **`by_transfer_id` index** в IndexedDB — O(log n) lookup, валидация regex перед сохранением
- DB_VERSION 2→3

---

## [v1.2.31–1.2.35] — 2026 (до мая)

### Добавлено
- **Perplexity** — поддержка вставки файлов: `_dragSequence` fallback + предупреждение о Pro-аккаунте
- Perplexity Pro: корректно вставляет файл и показывает friendly warning вместо тихой ошибки

---

## [v1.2.30] — 2026 (до мая)

### Добавлено
- **Mistral** — вставка файлов через `ClipboardEvent('paste')` на `.ProseMirror`; обход проверки `isTrusted` на programmatic drop events

---

## [v1.2.28–1.2.29] — 2026 (до мая)

### Добавлено
- **Gemini** — вставка файлов через `ClipboardEvent('paste')` на `.ql-editor` (Angular xap-кнопка отвергала synthetic DragEvent по `isTrusted`)
- Paste-стратегия применена везде: drop + кнопка вставки в Gemini

---

## [v1.2.x] — ранние версии

### Фундамент продукта

- **Простой перенос** (2 шага) — модель генерирует JSON-снапшот, расширение перехватывает и вставляет на следующей вкладке
- **Расширенный перенос** (3 шага) — с проверкой якорей и уточняющими вопросами
- **Прикрепление файлов** — drag & drop из side panel прямо в чат LLM (cross-window drag через `chrome.storage.local`)
- **Mind map** — SVG-граф снапшотов с навигацией, zoom, tooltip; `PR_MapRenderer` class
- **История** — список снапшотов с фильтрами по проекту, diff между версиями, экспорт
- **Проекты** — именованные группы снапшотов; dropdown с созданием, переименованием, выбором
- **Активный снапшот** — раскрывающаяся карточка с целью, статусом, следующим шагом, ключевыми решениями
- **Темы** — dark/light mode с синхронизацией между popup и content-script
- **Платформы на старте** — Claude ✅, ChatGPT ✅, Grok ✅, Deepseek ✅
- IndexedDB `SessionPort_v1`, stores: `snapshots`, `refs`, `meta`, `blobs`, `snapshot_files`
- Chrome Extension MV3: side panel (не popup), Service Worker, content-bundle (4 блока в одном файле)

---

## Итого по платформам

| Платформа | Метод вставки | Добавлена |
|-----------|--------------|-----------|
| Claude | `input[type=file]` setter | v1.x |
| ChatGPT | `_dropOnly` (Popover API) | v1.x |
| Grok | `input[type=file]` setter | v1.x |
| Deepseek | `input[type=file]` setter | v1.x |
| Gemini | `ClipboardEvent('paste')` на `.ql-editor` | v1.2.28 |
| Mistral | `ClipboardEvent('paste')` на `.ProseMirror` | v1.2.30 |
| Perplexity | `input[type=file]` + `_dragSequence` fallback | v1.2.31–35 |
