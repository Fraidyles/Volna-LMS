-- Схема этапа 1: пользователи и роли, приглашения по email,
-- демо-курс с уроками и тестом, прогресс, сообщения куратор—врач.
-- Идентификаторы — TEXT (генерируются в приложении через crypto.randomUUID()),
-- чтобы не требовать расширений PostgreSQL вроде pgcrypto.

CREATE TABLE IF NOT EXISTS users (
  id                TEXT PRIMARY KEY,
  email             TEXT UNIQUE NOT NULL,
  password_hash     TEXT NOT NULL,
  name              TEXT NOT NULL,
  role              TEXT NOT NULL CHECK (role IN ('student','curator','admin','super_admin')),
  specialization    TEXT,
  workplace         TEXT,
  phone             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invites (
  email             TEXT PRIMARY KEY,
  role              TEXT NOT NULL CHECK (role IN ('student','curator','admin')),
  invited_by        TEXT,
  invited_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS courses (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lessons (
  id                TEXT PRIMARY KEY,
  course_id         TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  idx               INT NOT NULL,
  title             TEXT NOT NULL,
  duration          TEXT,
  html              TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS quiz_questions (
  id                TEXT PRIMARY KEY,
  course_id         TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  idx               INT NOT NULL,
  question          TEXT NOT NULL,
  options           JSONB NOT NULL,
  correct           INT NOT NULL
);

CREATE TABLE IF NOT EXISTS progress (
  user_id                 TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  course_id               TEXT NOT NULL REFERENCES courses(id),
  completed_lessons       JSONB NOT NULL DEFAULT '[]',
  quiz_answers            JSONB NOT NULL DEFAULT '{}',
  quiz_score              INT,
  completed               BOOLEAN NOT NULL DEFAULT false,
  certificate_status      TEXT NOT NULL DEFAULT 'none',
  certificate_issued_at   TIMESTAMPTZ,
  certificate_issued_by   TEXT,
  requested_full_access   BOOLEAN NOT NULL DEFAULT false,
  last_active_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_lessons_course ON lessons(course_id);
CREATE INDEX IF NOT EXISTS idx_quiz_course ON quiz_questions(course_id);

-- ---------- Этап 2: потоки и календарь прямых эфиров ----------

CREATE TABLE IF NOT EXISTS streams (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  start_date        DATE,
  created_by        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS stream_id TEXT REFERENCES streams(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS events (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  event_date        DATE NOT NULL,
  event_time        TEXT,
  duration_min      INT NOT NULL DEFAULT 60,
  speaker           TEXT,
  stream_id         TEXT REFERENCES streams(id) ON DELETE SET NULL,
  join_url          TEXT,
  description       TEXT,
  created_by        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_events_date ON events(event_date);
CREATE INDEX IF NOT EXISTS idx_users_stream ON users(stream_id);

-- ---------- Этап 3: сроки/блокировка доступа, видимость материалов по врачам ----------

ALTER TABLE progress ADD COLUMN IF NOT EXISTS access_expires_at DATE;
ALTER TABLE progress ADD COLUMN IF NOT EXISTS access_blocked BOOLEAN NOT NULL DEFAULT false;

-- Один JSON-объект на курс вида {"l1": ["uid1","uid2"], "quiz": ["uid3"]} —
-- список id врачей, от которых скрыт конкретный урок/тест.
CREATE TABLE IF NOT EXISTS course_visibility (
  course_id   TEXT PRIMARY KEY REFERENCES courses(id) ON DELETE CASCADE,
  hidden_for  JSONB NOT NULL DEFAULT '{}'
);

-- ---------- Этап 4: поля для Dashboard (продукт, оплата, ответственный куратор) ----------

ALTER TABLE users ADD COLUMN IF NOT EXISTS product TEXT NOT NULL DEFAULT 'longevity';
ALTER TABLE users ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'unpaid';
ALTER TABLE users ADD COLUMN IF NOT EXISTS assigned_curator_id TEXT REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_users_curator ON users(assigned_curator_id);

-- ---------- Этап 5: безопасность, журнал, черновики/история, повторы эфиров, рефералы ----------

-- Отзыв токенов: при смене/сбросе пароля или явном "выйти со всех устройств"
-- увеличиваем token_version — все выданные раньше JWT перестают приниматься.
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INT NOT NULL DEFAULT 0;

-- Реферальная программа
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code TEXT UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by TEXT REFERENCES users(id) ON DELETE SET NULL;

-- Журнал действий персонала — для комплаенса: кто, что и с кем сделал
CREATE TABLE IF NOT EXISTS audit_log (
  id            TEXT PRIMARY KEY,
  actor_id      TEXT,
  actor_name    TEXT NOT NULL,
  actor_role    TEXT,
  action        TEXT NOT NULL,
  target_type   TEXT,
  target_id     TEXT,
  target_name   TEXT,
  details       JSONB NOT NULL DEFAULT '{}',
  revertible    BOOLEAN NOT NULL DEFAULT false,
  reverted_at   TIMESTAMPTZ,
  reverted_by   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_id);

-- Черновики уроков: правки сохраняются отдельно и не видны врачам, пока не опубликованы
ALTER TABLE lessons ADD COLUMN IF NOT EXISTS draft_title TEXT;
ALTER TABLE lessons ADD COLUMN IF NOT EXISTS draft_duration TEXT;
ALTER TABLE lessons ADD COLUMN IF NOT EXISTS draft_html TEXT;
ALTER TABLE lessons ADD COLUMN IF NOT EXISTS has_draft BOOLEAN NOT NULL DEFAULT false;

-- История версий урока — снимок перед каждой публикацией, чтобы можно было откатить
CREATE TABLE IF NOT EXISTS lesson_history (
  id            TEXT PRIMARY KEY,
  lesson_id     TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  duration      TEXT,
  html          TEXT NOT NULL,
  edited_by     TEXT,
  edited_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lesson_history_lesson ON lesson_history(lesson_id, edited_at DESC);

-- Повторяющиеся эфиры: группа для серии + правило повтора
ALTER TABLE events ADD COLUMN IF NOT EXISTS recurrence_group_id TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS recurrence TEXT;
CREATE INDEX IF NOT EXISTS idx_events_recurrence_group ON events(recurrence_group_id);

-- ---------- Этап 6: непрочитанные сообщения, заметки к уроку, приватные заметки куратора ----------

-- Личные заметки врача к урокам: {"l1": "текст заметки", ...} — видны только ему самому.
ALTER TABLE progress ADD COLUMN IF NOT EXISTS lesson_notes JSONB NOT NULL DEFAULT '{}';

-- Приватные заметки персонала о враче — отдельно от чата, врач их не видит никогда.
CREATE TABLE IF NOT EXISTS student_notes (
  id            TEXT PRIMARY KEY,
  student_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  author_id     TEXT,
  author_name   TEXT NOT NULL,
  body          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_student_notes_student ON student_notes(student_id, created_at DESC);

-- ---------- Этап 7: конструктор курса, дрип-открытие, коммьюнити потока, уведомления, геймификация ----------

-- Дрип: урок открывается автоматически через N дней после регистрации врача (NULL — сразу).
ALTER TABLE lessons ADD COLUMN IF NOT EXISTS drip_days INT;

-- Точка отсчёта "когда врач начал курс" — раньше не хранилась отдельно от created_at пользователя.
ALTER TABLE progress ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Геймификация: серия дней подряд с активностью + очки считаются на лету из прогресса, не хранятся.
ALTER TABLE progress ADD COLUMN IF NOT EXISTS current_streak INT NOT NULL DEFAULT 0;
ALTER TABLE progress ADD COLUMN IF NOT EXISTS longest_streak INT NOT NULL DEFAULT 0;
ALTER TABLE progress ADD COLUMN IF NOT EXISTS last_streak_date DATE;

-- Онбординг-чеклист: врач может закрыть карточку вручную, не дожидаясь выполнения всех пунктов.
ALTER TABLE progress ADD COLUMN IF NOT EXISTS onboarding_dismissed BOOLEAN NOT NULL DEFAULT false;

-- Центр уведомлений врача.
CREATE TABLE IF NOT EXISTS notifications (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT,
  read_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC);

-- ---------- Этап 8: расписание уроков куратором, поиск/избранное, мьют чатов, сеансы входа ----------

-- Куратор вручную назначает дату открытия урока конкретному врачу — переопределяет
-- автоматический дрип (lessons.drip_days от даты регистрации). По одной записи на
-- пару (врач, урок): повторная установка обновляет unlock_at, а не плодит дубли.
CREATE TABLE IF NOT EXISTS lesson_schedule_overrides (
  id            TEXT PRIMARY KEY,
  student_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lesson_id     TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  unlock_at     TIMESTAMPTZ NOT NULL,
  set_by        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(student_id, lesson_id)
);
CREATE INDEX IF NOT EXISTS idx_lesson_schedule_student ON lesson_schedule_overrides(student_id);
CREATE INDEX IF NOT EXISTS idx_lesson_schedule_lesson ON lesson_schedule_overrides(lesson_id);

-- «Мои материалы»: врач помечает урок как сохранённый себе для быстрого доступа.
CREATE TABLE IF NOT EXISTS student_bookmarks (
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lesson_id     TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, lesson_id)
);

-- История входов — для экрана «Мой профиль» → «Текущие сеансы» (устройство/откуда/когда).
CREATE TABLE IF NOT EXISTS login_sessions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_agent    TEXT,
  ip            TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_login_sessions_user ON login_sessions(user_id, created_at DESC);

-- ---------- Этап 9: «онлайн сейчас» и «был(а) в сети» для куратора ----------
-- Отдельно от last_active_at: last_active_at — это содержательное действие
-- (пройден урок/тест), от него зависят стрик и «неактивны 7+ дней» в инбоксе.
-- last_seen_at — просто "приложение было открыто", обновляется даже если врач
-- ничего не проходит, а читает материалы/чат — обновляется хартбитом с фронтенда.
ALTER TABLE progress ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

-- is_online — явный флаг (как в Telegram/VK): включается хартбитом, выключается
-- явным сигналом при закрытии вкладки (навигатор.sendBeacon на pagehide) — поэтому
-- статус пропадает мгновенно, а не только после истечения тайм-аута. last_seen_at
-- при этом даёт safety-net на случай краша вкладки без события выгрузки (см. withOnlineStatus).
ALTER TABLE progress ADD COLUMN IF NOT EXISTS is_online BOOLEAN NOT NULL DEFAULT false;

-- ---------- Этап 11: протоколы, разблокируемые по мере прохождения уроков ----------
-- Справочник специализаций — фиксированный список (не свободный текст), чтобы протоколы
-- можно было надёжно сопоставлять врачу по id, а не по нечёткому совпадению строк.
-- users.specialization (текст) при этом не трогаем — он остаётся денормализованным
-- кэшем названия для всех существующих мест (дашборд, ростер, CSV), которые читают
-- его как обычную строку; при сохранении specialization_id сервер синхронизирует оба поля.
CREATE TABLE IF NOT EXISTS specializations (
  id      TEXT PRIMARY KEY,
  name    TEXT NOT NULL UNIQUE
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS specialization_id TEXT REFERENCES specializations(id);

-- «Хочу развиваться в...» — отдельно от основной специализации, влияет только на то,
-- какие протоколы попадают в «по вашей специализации» на странице «Ваши протоколы».
CREATE TABLE IF NOT EXISTS user_specialization_interests (
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  specialization_id  TEXT NOT NULL REFERENCES specializations(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, specialization_id)
);

-- Видео урока — отдельно от html (текстовое интро с картинками, как было и раньше).
-- video_timecodes: [{ id, time (сек), title, summary (html) }, ...] — главы видео;
-- summary конкретной главы показывается под плеером, пока идёт воспроизведение этой главы.
ALTER TABLE lessons ADD COLUMN IF NOT EXISTS video_url TEXT;
ALTER TABLE lessons ADD COLUMN IF NOT EXISTS video_timecodes JSONB NOT NULL DEFAULT '[]';

-- Поурочный тест — отдельно от единого итогового теста курса (quiz_questions с
-- lesson_id IS NULL — это он и есть, поведение не меняется). lesson_id IS NOT NULL —
-- «развлекательный» тест конкретного урока на запоминание материала.
ALTER TABLE quiz_questions ADD COLUMN IF NOT EXISTS lesson_id TEXT REFERENCES lessons(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_quiz_lesson ON quiz_questions(lesson_id);

ALTER TABLE progress ADD COLUMN IF NOT EXISTS lesson_quiz_scores JSONB NOT NULL DEFAULT '{}';

-- Протокол: общее summary + отдельный гайд применения под каждую специализацию
-- (для кардиолога и дерматолога один и тот же протокол работает по-разному).
CREATE TABLE IF NOT EXISTS protocols (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  summary       TEXT NOT NULL DEFAULT '',
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS protocol_guides (
  id                 TEXT PRIMARY KEY,
  protocol_id        TEXT NOT NULL REFERENCES protocols(id) ON DELETE CASCADE,
  specialization_id  TEXT NOT NULL REFERENCES specializations(id) ON DELETE CASCADE,
  guide_html         TEXT NOT NULL,
  UNIQUE (protocol_id, specialization_id)
);

-- Какие протоколы разблокирует конкретный урок — множество (один протокол может
-- упоминаться в нескольких уроках, один урок может открывать несколько протоколов).
CREATE TABLE IF NOT EXISTS lesson_protocols (
  lesson_id     TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  protocol_id   TEXT NOT NULL REFERENCES protocols(id) ON DELETE CASCADE,
  PRIMARY KEY (lesson_id, protocol_id)
);
CREATE INDEX IF NOT EXISTS idx_lesson_protocols_protocol ON lesson_protocols(protocol_id);

-- Стартовый справочник специализаций под профиль платформы (anti-age/регенеративная
-- медицина) — админ может расширить список через админку (см. routes/specializations.js).
INSERT INTO specializations (id, name) VALUES
  ('therapist', 'Терапевт'),
  ('endocrinologist', 'Эндокринолог'),
  ('dermatocosmetologist', 'Дерматокосметолог'),
  ('gynecologist', 'Гинеколог'),
  ('nutritionist', 'Нутрициолог / диетолог'),
  ('cardiologist', 'Кардиолог'),
  ('gastroenterologist', 'Гастроэнтеролог'),
  ('neurologist', 'Невролог'),
  ('sports_medicine', 'Спортивная медицина и реабилитация'),
  ('family_doctor', 'Семейный врач'),
  ('anti_age', 'Anti-age и регенеративная медицина')
ON CONFLICT (id) DO NOTHING;

-- ---------- Этап 12: файлы-вложения к гайдам протоколов ----------
-- Куратор или админ может приложить к гайду специализации несколько файлов
-- (памятка PDF, чек-лист и т.п.) — их видит врач, которому открылся протокол
-- (там же, где и сам текст гайда). Файл физически лежит в uploads/protocol-guides/,
-- filename — сгенерированное имя на диске, original_name — как назывался у автора.
CREATE TABLE IF NOT EXISTS protocol_guide_files (
  id                 TEXT PRIMARY KEY,
  guide_id           TEXT NOT NULL REFERENCES protocol_guides(id) ON DELETE CASCADE,
  filename           TEXT NOT NULL,
  original_name      TEXT NOT NULL,
  mime_type          TEXT,
  size_bytes         INT NOT NULL DEFAULT 0,
  uploaded_by        TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_protocol_guide_files_guide ON protocol_guide_files(guide_id);

-- Текст гайда — больше не обязателен: куратор может сперва просто приложить файл,
-- а текст добавить позже (или не добавлять вовсе, если вся суть — во вложении).
ALTER TABLE protocol_guides ALTER COLUMN guide_html DROP NOT NULL;
ALTER TABLE protocol_guides ALTER COLUMN guide_html SET DEFAULT '';

-- ---------- Этап 13: модули курса — итоговый тест и мини-опрос после каждого модуля ----------
-- Модуль — группа уроков курса (например, 8 подряд). Урок вне модуля (module_id NULL)
-- ведёт себя как раньше — без гейта после себя.
CREATE TABLE IF NOT EXISTS modules (
  id          TEXT PRIMARY KEY,
  course_id   TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  idx         INT NOT NULL,
  title       TEXT NOT NULL
);
ALTER TABLE lessons ADD COLUMN IF NOT EXISTS module_id TEXT REFERENCES modules(id) ON DELETE SET NULL;

-- Тест по модулю — тот же quiz_questions, третья группа наравне с итоговым тестом
-- курса (lesson_id IS NULL, module_id IS NULL) и поурочным (lesson_id IS NOT NULL).
ALTER TABLE quiz_questions ADD COLUMN IF NOT EXISTS module_id TEXT REFERENCES modules(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_quiz_module ON quiz_questions(module_id);

ALTER TABLE progress ADD COLUMN IF NOT EXISTS module_quiz_scores JSONB NOT NULL DEFAULT '{}';

-- Мини-опрос по модулю — интерактивный, не текстовая форма: оценка 1-5 звёзд
-- обязательна, комментарий по желанию. Один отзыв на пару (модуль, врач) —
-- повторное прохождение (если врач вернётся к урокам модуля) обновляет его.
CREATE TABLE IF NOT EXISTS module_feedback (
  id          TEXT PRIMARY KEY,
  module_id   TEXT NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating      INT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (module_id, user_id)
);

-- ---------- Этап 14: загрузка видео урока файлом (не только по внешней ссылке) ----------
-- video_filename — имя файла на диске (uploads/lesson-videos/), если видео загружено
-- через админку; NULL — если video_url это обычная внешняя ссылка, введённая руками.
ALTER TABLE lessons ADD COLUMN IF NOT EXISTS video_filename TEXT;

-- ---------- Этап 15: код для регистрации с ролью сотрудника (защита приглашений) ----------
-- Раньше регистрация по email из приглашения (invites.role='curator'/'admin') сама
-- по себе присваивала эту роль — без проверки, что регистрируется именно тот, кого
-- позвали. Теперь для роли curator/admin регистрация дополнительно требует верный
-- код — единственная строка-синглтон, которую видно только в «Команда» у
-- admin/super_admin (GET /staff/invite-code) и которая автоматически перевыпускается,
-- если ей больше 24 часов (см. src/staffInviteCode.js).
CREATE TABLE IF NOT EXISTS staff_invite_code (
  id            TEXT PRIMARY KEY DEFAULT 'current',
  code          TEXT NOT NULL,
  generated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Этап 16: врач может указывать НЕСКОЛЬКО текущих специализаций ----------
-- Раньше "текущая" специализация была одна (users.specialization/specialization_id) —
-- не отражало реальность: многие врачи практикуют сразу в нескольких направлениях.
-- Эта таблица по структуре зеркальна user_specialization_interests (та про "хочу
-- развиваться в...", эта — про "уже практикую сейчас"); от нашего профиля-справочника
-- specializations зависит и подбор протоколов. Старые users.specialization/
-- specialization_id не трогаем и не удаляем (денормализованный след истории), но
-- новый код их больше не читает и не пишет — единственный источник истины теперь эта таблица.
CREATE TABLE IF NOT EXISTS user_specializations (
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  specialization_id  TEXT NOT NULL REFERENCES specializations(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, specialization_id)
);

-- ---------- Этап 17: расширить справочник специализаций до 50 ----------
-- Раньше в справочнике было только 11 специализаций (под нишу anti-age) — с
-- выпадающим списком и поиском по названию нужен более полный список, чтобы
-- врач нашёл свою, а не выбирал "ближайшую по смыслу". Дополняем существующие
-- 11 ещё 39 самыми частыми врачебными специальностями (итого 50).
INSERT INTO specializations (id, name) VALUES
  ('pediatrician', 'Педиатр'),
  ('surgeon', 'Хирург'),
  ('traumatologist', 'Травматолог-ортопед'),
  ('urologist', 'Уролог'),
  ('andrologist', 'Андролог'),
  ('ophthalmologist', 'Офтальмолог'),
  ('otolaryngologist', 'Оториноларинголог (ЛОР)'),
  ('psychiatrist', 'Психиатр'),
  ('psychotherapist', 'Психотерапевт'),
  ('narcologist', 'Нарколог'),
  ('dentist', 'Стоматолог'),
  ('dermatovenerologist', 'Дерматовенеролог'),
  ('cosmetologist', 'Косметолог'),
  ('plastic_surgeon', 'Пластический хирург'),
  ('allergist_immunologist', 'Аллерголог-иммунолог'),
  ('rheumatologist', 'Ревматолог'),
  ('nephrologist', 'Нефролог'),
  ('pulmonologist', 'Пульмонолог'),
  ('hematologist', 'Гематолог'),
  ('oncologist', 'Онколог'),
  ('mammologist', 'Маммолог'),
  ('proctologist', 'Колопроктолог'),
  ('phlebologist', 'Флеболог'),
  ('cardiac_surgeon', 'Кардиохирург'),
  ('neurosurgeon', 'Нейрохирург'),
  ('anesthesiologist', 'Анестезиолог-реаниматолог'),
  ('infectious_disease', 'Инфекционист'),
  ('radiologist', 'Рентгенолог'),
  ('ultrasound_diagnostics', 'Врач УЗИ-диагностики'),
  ('functional_diagnostics', 'Врач функциональной диагностики'),
  ('lab_diagnostics', 'Врач клинической лабораторной диагностики'),
  ('general_practitioner', 'Врач общей практики'),
  ('geriatrician', 'Гериатр'),
  ('reproductologist', 'Репродуктолог (ЭКО)'),
  ('rehabilitologist', 'Реабилитолог'),
  ('physiotherapist', 'Физиотерапевт'),
  ('sleep_medicine', 'Сомнолог'),
  ('geneticist', 'Врач-генетик'),
  ('bariatric_surgeon', 'Бариатрический хирург')
ON CONFLICT (id) DO NOTHING;

-- ---------- Этап 18: настоящий PDF-файл сертификата, а не только статус в базе ----------
-- Номер генерируется один раз при выдаче (issue/bulk-issue) и переиспользуется при
-- каждом скачивании — PDF рендерится на лету из certificate_number + данных студента/
-- курса, а не хранится файлом на диске (тут нечего инвалидировать при повторной генерации).
ALTER TABLE progress ADD COLUMN IF NOT EXISTS certificate_number TEXT;

-- ---------- Этап 19: выдача сертификатов — переключатель по курсу ----------
-- Текущий курс — демо-версия: материалы уже полноценные, но сертификат за него не
-- выдаётся (это отдельное обещание для настоящей полной программы). По умолчанию
-- false, чтобы демо-курс ничего не выдавал прямо сейчас; когда появится полноценный
-- курс — включаем флаг у него, и уже собранная инфраструктура (PDF, скачивание)
-- заработает без единой правки кода.
ALTER TABLE courses ADD COLUMN IF NOT EXISTS certificates_enabled BOOLEAN NOT NULL DEFAULT false;

-- ---------- Этап 20: убрали внутренние чаты — общение переехало в Telegram-группу потока ----------
-- Личный чат врач-куратор, общий чат потока, мьюты обоих чатов и библиотека шаблонов
-- ответов куратора удалены целиком вместе с данными (решение принято осознанно —
-- история переписки не нужна, всё общение теперь идёт в Telegram). CASCADE не нужен:
-- ни одна другая таблица не ссылается на эти внешним ключом (проверено).
DROP TABLE IF EXISTS chat_templates;
DROP TABLE IF EXISTS chat_mutes;
DROP TABLE IF EXISTS stream_messages;
DROP TABLE IF EXISTS messages;
ALTER TABLE progress DROP COLUMN IF EXISTS messages_read_at;

-- Вместо чата потока — прямая ссылка на его Telegram-группу, куда завели общение
-- студентов, кураторов и преподавателей.
ALTER TABLE streams ADD COLUMN IF NOT EXISTS telegram_url TEXT;

-- ---------- Этап 21: несколько курсов — врач может учиться сразу на нескольких ----------
-- Раньше progress.user_id был первичным ключом (одна запись на врача, один курс на
-- всю жизнь аккаунта). Теперь ключ — пара (user_id, course_id): у врача может быть
-- несколько строк progress, по одной на каждый курс, на который он записан.
-- DROP+ADD при каждом прогоне идемпотентен (см. соглашение файла) — на другие таблицы
-- progress ничем не ссылается, так что пересоздание PK ничего не ломает.
ALTER TABLE progress DROP CONSTRAINT IF EXISTS progress_pkey;
ALTER TABLE progress ADD PRIMARY KEY (user_id, course_id);

ALTER TABLE courses ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- ---------- Этап 22: экспорт/импорт данных персоналом ----------
-- Дата заявки нужна для выгрузки лидов (кто и когда попросил полный курс) —
-- раньше был только булев флаг без времени.
ALTER TABLE progress ADD COLUMN IF NOT EXISTS requested_full_access_at TIMESTAMPTZ;

-- ---------- Этап 23: фикс — удаление курса каскадно уносит прогресс врачей ----------
-- progress.course_id был объявлен без ON DELETE CASCADE (в отличие от lessons/
-- quiz_questions/modules, у которых он есть с самого начала) — DELETE /api/courses/:id
-- падал с нарушением внешнего ключа на любом курсе, где хоть один врач записан,
-- вместо ожидаемого поведения "удалить курс и весь его прогресс". Составное имя
-- ограничения Postgres генерирует сам как <table>_<column>_fkey — оно и есть
-- progress_course_id_fkey; drop+add идемпотентен, как и везде в этом файле.
ALTER TABLE progress DROP CONSTRAINT IF EXISTS progress_course_id_fkey;
ALTER TABLE progress ADD CONSTRAINT progress_course_id_fkey FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE;

-- ---------- Фото профиля ----------
-- Имя файла в uploads/avatars (сам файл отдаёт GET /api/auth/avatar/:file только
-- авторизованным). NULL — фото нет, показываются инициалы.
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_file TEXT;

-- ---------- Этап 24: задания к урокам с проверкой куратором ----------
-- Задание — текстовое поле у самого урока (как в GetCourse): формулировка и флаг
-- «стоп-урок». Стоп-урок не засчитывается, пока куратор не примет ответ; принятие
-- само засчитывает урок. Необязательное задание урок не держит.
ALTER TABLE lessons ADD COLUMN IF NOT EXISTS assignment_prompt TEXT;
ALTER TABLE lessons ADD COLUMN IF NOT EXISTS assignment_required BOOLEAN NOT NULL DEFAULT false;

-- Один ответ на пару (урок, врач); повторная отправка после возврата обновляет его.
-- history — вся переписка по ответу: [{at, kind: submit|accept|return, by, name, text}].
CREATE TABLE IF NOT EXISTS assignment_submissions (
  id            TEXT PRIMARY KEY,
  lesson_id     TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  course_id     TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  answer        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','returned')),
  curator_comment TEXT,
  reviewed_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at   TIMESTAMPTZ,
  submitted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts      INT NOT NULL DEFAULT 1,
  history       JSONB NOT NULL DEFAULT '[]',
  UNIQUE (lesson_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_assign_status ON assignment_submissions(status, submitted_at);

-- ---------- Этап 25: продукты, заказы, оплаты и рассрочки ----------
-- Продукт — то, что продаётся (цена, опционально — курс, доступ к которому
-- открывается при полной оплате). Заказ — продукт для конкретного врача со своей
-- ценой (скидка) и графиком платежей: один платёж или рассрочка на N частей.
CREATE TABLE IF NOT EXISTS products (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  price         INT NOT NULL CHECK (price >= 0),
  course_id     TEXT REFERENCES courses(id) ON DELETE SET NULL,
  max_installments INT NOT NULL DEFAULT 1 CHECK (max_installments BETWEEN 1 AND 24),
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
  id            TEXT PRIMARY KEY,
  number        SERIAL,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id    TEXT REFERENCES products(id) ON DELETE SET NULL,
  title         TEXT NOT NULL,
  amount        INT NOT NULL CHECK (amount >= 0),
  status        TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','partial','paid','cancelled')),
  comment       TEXT,
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);

-- Строки графика: due_date — когда платёж ожидается, paid_at — когда реально пришёл.
CREATE TABLE IF NOT EXISTS order_payments (
  id            TEXT PRIMARY KEY,
  order_id      TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  idx           INT NOT NULL,
  amount        INT NOT NULL CHECK (amount >= 0),
  due_date      DATE NOT NULL,
  paid_at       TIMESTAMPTZ,
  marked_by     TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_order_payments_order ON order_payments(order_id);

-- ---------- Этап 26: анкеты и опросы ----------
-- questions: [{id, type: single|multi|scale|text, text, options[], required}].
-- course_id NULL — анкета для всех врачей, иначе только для записанных на курс.
CREATE TABLE IF NOT EXISTS surveys (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  description   TEXT,
  questions     JSONB NOT NULL DEFAULT '[]',
  course_id     TEXT REFERENCES courses(id) ON DELETE CASCADE,
  active        BOOLEAN NOT NULL DEFAULT true,
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS survey_responses (
  id            TEXT PRIMARY KEY,
  survey_id     TEXT NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  answers       JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (survey_id, user_id)
);

-- ---------- Этап 27: заказ помнит, что именно он открыл курс ----------
-- Отмена такого заказа закрывает доступ к курсу (прогресс не удаляется). Курс,
-- на который врач был записан до покупки, отмена не трогает.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS opened_course BOOLEAN NOT NULL DEFAULT false;

-- ---------- Этап 28: адрес загруженного видео урока — относительный ----------
-- Абсолютный «/api/...» ломал воспроизведение при монтировании в подпапку (BASE_PATH).
UPDATE lessons SET video_url = substr(video_url, 2) WHERE video_url LIKE '/api/course/lessons/%/video-file';

-- ---------- Этап 29: ссылки на Telegram-группы — всегда https://t.me/… ----------
-- Раньше сохранялись как есть; без схемы («t.me/+abc») браузер уводил на
-- несуществующую страницу платформы. Нормализуем то, что уже сохранено.
UPDATE streams SET telegram_url = 'https://t.me/' || regexp_replace(telegram_url, '^(https?://)?(www\.)?(t\.me|telegram\.me|telegram\.dog)/', '', 'i')
  WHERE telegram_url ~* '^(https?://)?(www\.)?(t\.me|telegram\.me|telegram\.dog)/' AND telegram_url !~ '^https://t\.me/';

-- ---------- Этап 30: выделения маркером в тексте урока ----------
-- {lessonId: [{id, text, at}]} — врач выделяет фрагмент урока, он подсвечивается
-- при каждом следующем открытии. Хранится по тексту фрагмента (не по позиции),
-- чтобы правка соседних абзацев урока не сдвигала выделение.
ALTER TABLE progress ADD COLUMN IF NOT EXISTS lesson_highlights JSONB NOT NULL DEFAULT '{}';

-- ---------- Этап 31: «Активные сеансы» — одна запись на устройство ----------
-- Раньше каждый вход дописывал новую строку в login_sessions — один и тот же
-- браузер копился в списке много раз подряд (см. routes/auth.js POST /login).
-- Разово схлопываем то, что уже накопилось: для каждой пары
-- (user_id, user_agent, ip) оставляем только самый свежий вход.
DELETE FROM login_sessions WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY user_id, COALESCE(user_agent,''), COALESCE(ip,'')
      ORDER BY created_at DESC, id DESC
    ) AS rn
    FROM login_sessions
  ) dupes WHERE rn > 1
);
-- Дальше повторный вход с того же устройства (см. INSERT ... ON CONFLICT в
-- auth.js) обновляет дату существующей строки вместо новой — без этого
-- уникального индекса ON CONFLICT работать не может.
CREATE UNIQUE INDEX IF NOT EXISTS idx_login_sessions_device
  ON login_sessions(user_id, COALESCE(user_agent,''), COALESCE(ip,''));
