---
page: login
---
Экран входа для обучающей платформы врачей «Медицина Долголетия». Пользователь
попадает сюда либо чтобы войти по email/паролю, либо чтобы принять приглашение
(создать пароль по ссылке из письма).

**DESIGN SYSTEM (REQUIRED):**
- Platform: Web, Desktop-first (адаптив для планшета/телефона)
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
- Layout: calm, trustworthy, expert tone — not a sterile clinical look, not a decorative marketing look

**Page Structure:**
1. **Left/brand panel (desktop only, hidden on mobile):** глубокий зелёный
   (#1F5F52) фон, название платформы «Медицина Долголетия» серифом, короткая
   фраза о курсе для врачей, decorative ботанический/абстрактный узор в тон
2. **Right panel — форма в карточке (surface, radius 14px, soft shadow):**
   - Логотип/название сверху
   - Заголовок «Вход» серифом
   - Поле Email
   - Поле Пароль
   - Ссылка «Забыли пароль?» (muted, справа под полем)
   - Кнопка «Войти» — primary, полная ширина, 7px radius
   - Разделитель «или»
   - Блок принятия приглашения: короткий текст «Получили приглашение по
     email? Перейдите по ссылке из письма, чтобы задать пароль» — вторичным
     текстом, без отдельной кнопки (переход по ссылке из письма)
3. **Footer (мелкий текст):** название организации, год
