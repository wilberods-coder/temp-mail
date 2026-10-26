CREATE TABLE IF NOT EXISTS boxes (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  password TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS boxes_expires_at ON boxes (expires_at);
