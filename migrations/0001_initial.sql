CREATE TABLE records (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires INTEGER
);
CREATE INDEX records_expiry ON records(expires) WHERE expires IS NOT NULL;
