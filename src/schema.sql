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

CREATE TABLE IF NOT EXISTS messages (
  id                TEXT PRIMARY KEY,
  student_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_role         TEXT NOT NULL,
  author_name       TEXT,
  body              TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_student ON messages(student_id);
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

-- Момент, когда врач последний раз открывал свой чат — всё от куратора после этой
-- отметки считается непрочитанным (бейдж на вкладке «Сообщения»).
ALTER TABLE progress ADD COLUMN IF NOT EXISTS messages_read_at TIMESTAMPTZ;

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

-- Общение внутри потока (когорты): видно всем врачам этого потока + персоналу.
CREATE TABLE IF NOT EXISTS stream_messages (
  id            TEXT PRIMARY KEY,
  stream_id     TEXT NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
  author_id     TEXT,
  author_name   TEXT NOT NULL,
  author_role   TEXT NOT NULL,
  body          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stream_messages_stream ON stream_messages(stream_id, created_at);

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

-- Мьют чата: замьюченный чат не подсвечивается бейджем +N нигде в интерфейсе.
-- chat_type/chat_key: ('curator', studentId) — 1:1 чат конкретного врача с куратором
-- (с обеих сторон — и у врача, и у персонала свой собственный мьют); ('stream', streamId) — беседа потока.
CREATE TABLE IF NOT EXISTS chat_mutes (
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_type     TEXT NOT NULL,
  chat_key      TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, chat_type, chat_key)
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

