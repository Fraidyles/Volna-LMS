# Design System: Медицина Долголетия LMS
**Project ID:** _TBD — заполняется автоматически в `.stitch/metadata.json` при первом запуске цикла (`create_project`)_

> Извлечено из реального фронтенда (`public/styles.css`) действующего бэкенда LMS,
> а не сгенерировано с нуля — держите Stitch-макеты в этой же палитре, чтобы
> будущий редизайн совпадал с уже работающим продуктом.

## 1. Visual Theme & Atmosphere
Медицинская, но не стерильная платформа для врачей, проходящих курс по
longevity-медицине (пептидная терапия, персональный бренд и т.д.). Настроение —
спокойный кабинет фитотерапевта, а не больничный коридор: глубокий зелёный
(шалфей/хвоя) вместо голубого «клинического» цвета, тёплый терракотовый акцент,
сериф в заголовках для редакционного, экспертного ощущения. Плотность средняя —
это рабочий инструмент (дашборды, тесты, календарь), а не маркетинговый лендинг.

## 2. Color Palette & Roles

### Light (по умолчанию)
- **Background** (`#F5F7F4`) — основной фон страницы, тёплый серо-зелёный
- **Surface** (`#FFFFFF`) — карточки, модальные окна, поля ввода
- **Ink** (`#16241F`) — основной текст, почти чёрный с зелёным подтоном
- **Muted** (`#5C6C63`) — вторичный текст
- **Muted-2** (`#8A968F`) — третичный текст, плейсхолдеры
- **Line / Line-2** (`#DEE5DE` / `#EAEFE9`) — границы, разделители
- **Primary** (`#1F5F52`) — глубокий тёмно-зелёный: кнопки, ссылки, активные табы
- **Primary Dark** (`#123B33`) — hover/pressed состояния primary
- **Primary Tint** (`#E4EEEA`) — подложка для выделенных/активных элементов
- **Accent** (`#C1793A`) — тёплый терракотовый: badges, прогресс, акцентные CTA (не основной)
- **Accent Tint** (`#F7E9DA`) — подложка для accent-элементов
- **Danger** (`#B3492F`) — ошибки, блокировка доступа, откат действий
- **Danger Tint** (`#F6E4DE`) — подложка предупреждений

### Dark
- **Background** (`#121815`), **Surface** (`#1A211D`), **Ink** (`#EAEFEA`)
- **Muted** (`#A7B3AC`) / **Muted-2** (`#7C877F`)
- **Line** (`#2A332D`) / **Line-2** (`#232B26`)
- **Primary** (`#6FBBA6`), **Primary Dark** (`#8FD0BC` — светлее, для hover в тёмной теме)
- **Primary Tint** (`#1D2B26`)
- **Accent** (`#E3A468`), **Accent Tint** (`#2C2318`)
- **Danger** (`#E58A73`), **Danger Tint** (`#2E211C`)

Платформа поддерживает переключение тёмной темы — всегда учитывай обе палитры.

## 3. Typography Rules
- **Заголовки:** `Source Serif 4` (fallback Georgia, serif) — редакционный,
  экспертный тон для H1/H2, названий курсов и уроков
- **Интерфейс/текст:** `IBM Plex Sans` (fallback -apple-system, Helvetica, Arial)
  — вся UI-обвязка: кнопки, формы, таблицы, навигация, тело текста
- Никаких decorative/script-шрифтов — платформа для врачей, тон деловой

## 4. Component Stylings
* **Buttons:** скруглённые углы (`--radius-s: 7px`), primary — сплошная заливка
  `#1F5F52` с белым текстом; secondary — outline в `--line`; danger-действия
  (блокировка доступа, откат) — заливка `#B3492F`
* **Cards:** средний радиус (`--radius-m: 14px`), фон `--surface`, мягкая тень
  (`0 1px 2px rgba(20,30,25,.04), 0 8px 24px -12px rgba(20,30,25,.12)`), без
  жёстких границ — тень вместо контура
* **Inputs:** фон `--surface`, тонкая граница `--line`, focus-состояние —
  граница/ring в `--primary`, radius `--radius-s`
* **Modals/крупные контейнеры:** `--radius-l: 20px`
* **Badges/статусы:** сертификат/прогресс — `accent-tint` фон с `accent` текстом;
  ошибки/блокировка — `danger-tint` фон с `danger` текстом; успех/активно —
  `primary-tint` фон с `primary` текстом

## 5. Layout Principles
- Дашборд-ориентированная структура: боковая навигация (роль-зависимая:
  врач видит курс/календарь/сообщения, куратор/админ видят команду/учеников/журнал)
  + основная область с карточками и таблицами
- Умеренные отступы (не воздушный лендинг) — это рабочий инструмент с таблицами,
  фильтрами и календарём, плотность контента важнее «дыхания»
- Максимальная ширина контента ограничена на дашбордах для читаемости таблиц

## 6. Design System Notes for Stitch Generation
**Copy this block into every baton prompt:**

**DESIGN SYSTEM (REQUIRED):**
- Platform: Web, Desktop-first (адаптив для планшета; врачи используют и на телефоне для просмотра, но администрирование — десктоп)
- Theme: Light by default with full Dark mode support
- Background: warm sage off-white (#F5F7F4) / dark warm-charcoal (#121815) in dark mode
- Surface (cards/inputs): white (#FFFFFF) / dark surface (#1A211D) in dark mode
- Primary Accent: deep forest teal-green (#1F5F52), lighter mint-teal (#6FBBA6) in dark mode — buttons, active nav, links
- Secondary Accent: warm terracotta/amber (#C1793A), (#E3A468) in dark mode — badges, progress, non-primary CTAs
- Danger: muted brick red (#B3492F) / (#E58A73) in dark mode — access blocked, revert actions
- Text Primary: near-black deep green ink (#16241F) / off-white (#EAEFEA) in dark mode
- Text Secondary: muted sage-gray (#5C6C63) / (#A7B3AC) in dark mode
- Headings font: Source Serif 4 (editorial, expert tone)
- Body/UI font: IBM Plex Sans (clean, functional)
- Buttons: 7px rounded corners
- Cards: 14px rounded corners, soft shadow, no hard borders
- Modals: 20px rounded corners
- Layout: dashboard-style with role-based sidebar navigation + main content area with cards and data tables, moderate density, calm and trustworthy — not a sterile clinical look, not a decorative marketing look
