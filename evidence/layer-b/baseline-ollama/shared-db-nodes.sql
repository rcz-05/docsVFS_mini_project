PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE nodes (
  mount           TEXT NOT NULL,
  path            TEXT NOT NULL,
  parent          TEXT NOT NULL,
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('file','dir')),
  content         BLOB,
  size            INTEGER NOT NULL DEFAULT 0,
  mode            INTEGER NOT NULL DEFAULT 420,
  provenance      TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  ttl_expires_at  INTEGER,
  PRIMARY KEY (mount, path)
);
INSERT INTO nodes VALUES('/memory','/','','','dir',NULL,0,493,'{"session_id":"S1","source":"auto"}',1778188311158,1778188311158,NULL);
INSERT INTO nodes VALUES('/workspace','/','','','dir',NULL,0,493,'{"session_id":"S1","source":"auto"}',1778188311159,1778188311159,NULL);
COMMIT;
