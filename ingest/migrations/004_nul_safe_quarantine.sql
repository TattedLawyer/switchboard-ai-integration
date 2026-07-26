-- NUL-safe quarantine: Postgres jsonb cannot represent U+0000 (error 22P05), so a validly-signed
-- payload with a NUL in any string could not be stored in quarantine.payload — the one payload
-- class that most needs quarantine was the one it couldn't hold. Preserve such payloads as exact
-- JSON text instead: text happily holds the six-character \u0000 escape sequence, which is the
-- only form a NUL can take in valid JSON on the wire. payload stays jsonb for every other row
-- (queryability, replay); it is relaxed to nullable so NUL rows can carry raw_body alone.
alter table ingest.quarantine alter column payload drop not null;
alter table ingest.quarantine add column if not exists raw_body text;
