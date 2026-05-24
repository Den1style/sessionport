<p align="center">
  <img src="icons/icon128.png" width="96" alt="SessionPort" />
</p>

# SessionPort v1.0 — Chrome Extension

Бесшовный перенос контекста между LLM (Claude, ChatGPT, Grok, Gemini, Mistral, Deepseek, Perplexity) без внешних API.

## Возможности

- **Простой перенос** (2 шага) — модель автоматически генерирует JSON-снапшот
- **Расширенный перенос** (3 шага) — с проверкой якорей и уточняющими вопросами
- **Прикрепление файлов** — drag & drop из side panel в чат LLM
- **Mind map** — визуальный граф снапшотов с навигацией
- **Distributed chain** — transfer_id для связи снапшотов между устройствами
- **История** — поиск, фильтры по проекту, diff между снапшотами

## Установка

1. Откройте `chrome://extensions/`
2. Включите «Режим разработчика»
3. «Загрузить распакованное расширение» → выберите папку проекта

## Архитектура

Подробности в `DECISIONS.md`.

```
background.js        Service Worker
db.js                IndexedDB API (popup context)
content-bundle.js    Content scripts (isolated world)
main-world-inject.js MAIN world inject (Gemini/Mistral)
popup.html           Side panel UI
popup-shell.js       UI компоненты и экраны
popup-utils.js       UI утилиты
flow.js              Шаги переноса
capture.js           Захват снапшота
adapters.js          Адаптеры для каждой LLM
inject.js            Инъекция в страницу
files.js             Dropzone + drag out
history.js           История + diff
map-renderer.js      SVG граф
settings.js          Настройки
projects.js          Проекты
prompts.js           Промпт-библиотека
dashboard.js         Дашборд (full-page view)
google-drive.js      Google Drive бэкап
trash.js             Корзина
shared-utils.js      PR_Utils
i18n.js              Локализация (9 языков)
```

## DB

IndexedDB `SessionPort_v1`, DB_VERSION = 4.
Stores: snapshots, refs, meta, blobs, snapshot_files.
