---
stitch-project-id: TBD
---
# Project Vision & Constitution

> **AGENT INSTRUCTION:** Read this file before every iteration. It serves as the
> project's "Long-Term Memory." If `next-prompt.md` is empty, pick the highest
> priority item from Section 5 OR invent a new screen that fits the project vision.

## 1. Core Identity
* **Project Name:** Медицина Долголетия — LMS (платформа обучения)
* **Stitch Project ID:** `TBD` — будет создан и записан в `.stitch/metadata.json`
  автоматически на первой итерации цикла (`create_project`), затем скопирован сюда
* **Mission:** Обучающая платформа для врачей: демо-курс с уроками и тестом,
  прогресс, выдача сертификатов, потоки и календарь прямых эфиров, чат с
  куратором. Административная часть — управление командой (куратор/админ/
  супер-админ), учениками (врачами), доступом, журнал действий с откатом.
* **Target Audience:**
  - **Врачи (student)** — проходят курс, сдают тест, получают сертификат,
    смотрят эфиры, общаются с куратором
  - **Куратор (curator)** — ведёт закреплённых врачей, переписка, статусы
  - **Админ / супер-админ** — управление командой, приглашениями, потоками,
    видимостью материалов, Dashboard с фильтрами (продукт/оплата/куратор),
    журнал действий (только супер-админ видит кнопку «Откатить»)
* **Voice:** Экспертный, спокойный, деловой — платформа для врачей, не для
  массового потребителя. Доверие и точность важнее «продающего» тона.

## 2. Visual Language (Stitch Prompt Strategy)
*Strictly adhere to these descriptive rules when prompting Stitch. Do NOT use code.*

* **The "Vibe" (Adjectives):**
    * *Primary:* **Экспертный / клинический-но-тёплый** (не стерильно-белый, глубокий зелёный)
    * *Secondary:* **Спокойный / деловой** (дашборды, таблицы, фильтры — рабочий инструмент)
    * *Tertiary:* **Редакционный** (сериф в заголовках — ощущение учебника/курса, а не соцсети)

* **Color Philosophy (Semantic):** см. `.stitch/DESIGN.md` — палитра извлечена
  из реального фронтенда бэкенда (`public/styles.css`), а не придумана заново.
    * **Backgrounds:** тёплый серо-зелёный (#F5F7F4), тёмная тема — глубокий
      тёплый уголь (#121815)
    * **Primary Accent:** глубокий лесной тёмно-зелёный (#1F5F52)
    * **Secondary Accent:** тёплый терракотовый (#C1793A) — для бейджей/прогресса
    * **Danger:** приглушённый кирпично-красный (#B3492F) — блокировка доступа, откат

## 3. Architecture & File Structure
* **Root (Stitch mockups):** `site/public/`
* **Asset Flow:** Stitch генерирует в `.stitch/designs/` → проверка →
  перенос в `site/public/`
* **Navigation Strategy:**
    * **Врач (student):** Дашборд курса → Урок/Тест → Календарь эфиров →
      Сообщения (чат с куратором) → Сертификат
    * **Куратор/Админ/Супер-админ:** Dashboard (фильтры) → Ученики → Команда
      (приглашения) → Календарь/Потоки (создание эфиров, серии повторов) →
      Журнал действий (у супер-админа — кнопка «Откатить»)
* **Примечание:** это макеты для редизайна уже работающего продукта (Node.js/
  Express/PostgreSQL бэкенд + SPA-фронтенд без сборки). Цель цикла — довести
  визуальный дизайн до уровня, описанного в `DESIGN.md`, экран за экраном.

## 4. Live Sitemap (Current State)
*The Agent MUST update this section when a new page is successfully merged.*

* [ ] `login.html` — Вход / принятие приглашения по email
* [ ] `dashboard-student.html` — Дашборд врача: прогресс курса, ближайшие эфиры, статус сертификата
* [ ] `course.html` — Просмотр урока (текст/видео) + боковая навигация по урокам
* [ ] `quiz.html` — Прохождение теста демо-курса
* [ ] `calendar.html` — Календарь потоков и прямых эфиров (с учётом повторов)
* [ ] `messages.html` — Чат врач ↔ куратор
* [ ] `certificate.html` — Статус/просмотр выданного сертификата
* [ ] `dashboard-admin.html` — Dashboard куратора/админа с фильтрами (продукт, оплата, куратор)
* [ ] `students.html` — Список врачей: доступ, блокировка, видимость материалов, «глазами врача»
* [ ] `team.html` — Команда: приглашение куратора/админа по email, роли
* [ ] `audit-log.html` — Журнал действий с кнопкой «Откатить» (только супер-админ)

## 5. The Roadmap (Backlog)
*If `next-prompt.md` is empty or completed, pick the next task from here, in order.*

### High Priority (ядро пути врача)
- [ ] **Login / Invite Acceptance:** экран входа и принятия приглашения по email
- [ ] **Student Dashboard:** обзор прогресса, ближайший эфир, статус сертификата
- [ ] **Course / Lesson Viewer:** урок с прогресс-баром по курсу
- [ ] **Quiz Screen:** прохождение теста с вариантами ответов

### Medium Priority (вовлечение врача)
- [ ] **Calendar:** потоки + эфиры, включая повторяющиеся серии
- [ ] **Messages:** чат с куратором
- [ ] **Certificate:** статус/выдача сертификата

### Lower Priority (административная часть)
- [ ] **Admin Dashboard:** фильтры по продукту/оплате/куратору
- [ ] **Students Management:** доступ, сроки, скрытие материалов, CSV-импорт
- [ ] **Team Management:** приглашения, роли
- [ ] **Audit Log:** журнал с откатом (только супер-админ)

## 6. Creative Freedom Guidelines
*When the backlog is empty, follow these guidelines to innovate.*

1. **Stay On-Brand:** новые экраны должны соответствовать вайбу «экспертный,
   спокойный, редакционный» — глубокий зелёный + терракотовый акцент
2. **Enhance the Core:** поддерживают путь врача (обучение → тест → сертификат)
   или работу куратора/админа (управление, контроль доступа)
3. **Naming Convention:** латиница в нижнем регистре, описательные имена файлов

### Ideas to Explore
*Pick one, build it, then REMOVE it from this list.*

- [ ] `product-selector.html` — Экран выбора продукта («Пептидная терапия», «Личный бренд») при нескольких курсах
- [ ] `staff-csv-import.html` — Массовый импорт врачей по CSV
- [ ] `settings.html` — Настройки профиля, смена пароля, светлая/тёмная тема
- [ ] `referral.html` — Реферальная программа (поле `referral_code` уже есть в БД)
- [ ] `view-as-doctor.html` — Режим «просмотр глазами врача» для куратора/админа

## 7. Rules of Engagement
1. Не пересоздавать экраны из Раздела 4
2. Всегда обновлять `next-prompt.md` перед завершением итерации
3. Забирать идеи из Раздела 6, когда они использованы
4. Держать цикл живым — если Roadmap пуст, брать из Creative Freedom
