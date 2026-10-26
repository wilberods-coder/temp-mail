-- Ящики со сроком жизни (для удаления по cron)
CREATE TABLE IF NOT EXISTS boxes (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  password TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS boxes_expires_at ON boxes (expires_at);

-- Аккаунты: по имени пользователя и паролю или через Google
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE,
  password_hash TEXT,
  google_sub TEXT UNIQUE,
  email TEXT,
  name TEXT,
  picture TEXT,
  created_at INTEGER NOT NULL
);

-- В базе хранится только SHA-256 токена сессии
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);

-- Ящики, привязанные к аккаунту; expires_at = NULL — ящик навсегда
CREATE TABLE IF NOT EXISTS user_boxes (
  user_id TEXT NOT NULL,
  box_id TEXT NOT NULL,
  address TEXT NOT NULL,
  password TEXT NOT NULL,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, box_id)
);

CREATE INDEX IF NOT EXISTS user_boxes_box ON user_boxes (box_id);
