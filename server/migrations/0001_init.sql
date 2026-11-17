-- Farewatch v2 watch server: first schema.
-- Apply with: npx wrangler d1 migrations apply farewatch-v2 --remote
-- Rules: one column per setting (no JSON settings blobs), lists in child tables,
-- every child row deleted with its watch. Times are Unix milliseconds (UTC).

-- ---------- app settings (one row) ----------
CREATE TABLE settings (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  currency    TEXT    NOT NULL DEFAULT 'CAD',
  alert_email TEXT,                       -- used by alerts in step 4; never sent to the runner
  updated_at  INTEGER NOT NULL DEFAULT 0
);
INSERT INTO settings (id) VALUES (1);

CREATE TABLE settings_blocked_countries (
  country TEXT PRIMARY KEY                -- ISO2, default "no layovers in" list
);
INSERT INTO settings_blocked_countries (country) VALUES ('US');

-- ---------- login ----------
CREATE TABLE sessions (
  token_hash   TEXT    PRIMARY KEY,       -- SHA-256 of the token; the token itself is never stored
  binding      TEXT    NOT NULL,          -- SHA-256(password + ':' + token): a new password ends all sessions
  label        TEXT    NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);
CREATE INDEX sessions_expires ON sessions (expires_at);

CREATE TABLE login_failures (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ip_hash TEXT    NOT NULL,               -- SHA-256 of the caller IP
  at      INTEGER NOT NULL
);
CREATE INDEX login_failures_ip ON login_failures (ip_hash, at);

-- ---------- watches ----------
CREATE TABLE watches (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  name                  TEXT    NOT NULL,
  enabled               INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  origin                TEXT    NOT NULL,
  destination           TEXT    NOT NULL,
  currency              TEXT    NOT NULL,
  adults                INTEGER NOT NULL CHECK (adults BETWEEN 1 AND 6),
  children              INTEGER NOT NULL CHECK (children BETWEEN 0 AND 5),
  cabin                 INTEGER NOT NULL CHECK (cabin BETWEEN 1 AND 4),
  max_stops             INTEGER NOT NULL CHECK (max_stops BETWEEN 0 AND 2),
  max_layover           INTEGER NOT NULL CHECK (max_layover BETWEEN 30 AND 1440),
  max_outbound_tries    INTEGER NOT NULL DEFAULT 2 CHECK (max_outbound_tries BETWEEN 1 AND 3),
  out_from              TEXT    NOT NULL,
  out_to                TEXT    NOT NULL,
  back_from             TEXT,                       -- NULL = one way
  back_to               TEXT,
  budget                REAL    NOT NULL,
  reserve               REAL    NOT NULL DEFAULT 0,
  bags                  INTEGER NOT NULL DEFAULT 0 CHECK (bags BETWEEN 0 AND 4),
  allow_unverified_bags INTEGER NOT NULL DEFAULT 0 CHECK (allow_unverified_bags IN (0, 1)),
  pairs_per_run         INTEGER NOT NULL DEFAULT 5 CHECK (pairs_per_run BETWEEN 1 AND 10),
  revision              INTEGER NOT NULL DEFAULT 1, -- +1 when search settings change; old prices are removed
  cursor                INTEGER NOT NULL DEFAULT 0, -- next date combo to check
  last_checked_at       INTEGER NOT NULL DEFAULT 0,
  lease_run_id          TEXT,                       -- runner job that currently owns this watch
  lease_until           INTEGER NOT NULL DEFAULT 0,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);
CREATE INDEX watches_due ON watches (enabled, last_checked_at);

CREATE TABLE watch_blocked_countries (
  watch_id INTEGER NOT NULL REFERENCES watches (id) ON DELETE CASCADE,
  country  TEXT    NOT NULL,
  PRIMARY KEY (watch_id, country)
);

CREATE TABLE watch_airlines (
  watch_id INTEGER NOT NULL REFERENCES watches (id) ON DELETE CASCADE,
  airline  TEXT    NOT NULL,              -- IATA carrier code; no rows = any airline
  PRIMARY KEY (watch_id, airline)
);

-- Latest result per date combo for the watch's current revision.
CREATE TABLE watch_prices (
  watch_id     INTEGER NOT NULL REFERENCES watches (id) ON DELETE CASCADE,
  revision     INTEGER NOT NULL,
  out_date     TEXT    NOT NULL,
  back_date    TEXT    NOT NULL DEFAULT '',  -- '' = one way
  status       TEXT    NOT NULL CHECK (status IN ('ok', 'none')),
  price        REAL,                         -- cheapest allowed price (NULL when status = 'none')
  options_json TEXT    NOT NULL DEFAULT '[]',-- up to 5 allowed itineraries, cheapest first (flight details)
  checked_at   INTEGER NOT NULL,
  PRIMARY KEY (watch_id, out_date, back_date)
);

-- Every cheapest price seen, for history charts and alert rules (step 4).
CREATE TABLE price_history (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  watch_id  INTEGER NOT NULL REFERENCES watches (id) ON DELETE CASCADE,
  revision  INTEGER NOT NULL,
  out_date  TEXT    NOT NULL,
  back_date TEXT    NOT NULL DEFAULT '',
  price     REAL    NOT NULL,
  airlines  TEXT    NOT NULL DEFAULT '',     -- display only, e.g. "AC,CX"
  at        INTEGER NOT NULL
);
CREATE INDEX price_history_watch ON price_history (watch_id, out_date, back_date, at);

CREATE TABLE watch_runs (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  watch_id INTEGER NOT NULL REFERENCES watches (id) ON DELETE CASCADE,
  at       INTEGER NOT NULL,
  checked  INTEGER NOT NULL,
  found    INTEGER NOT NULL,
  errors   INTEGER NOT NULL,
  message  TEXT    NOT NULL
);
CREATE INDEX watch_runs_watch ON watch_runs (watch_id, id);

-- ---------- runner ----------
CREATE TABLE runner_jobs (
  id           TEXT    PRIMARY KEY,           -- random UUID given to the runner
  watch_id     INTEGER NOT NULL REFERENCES watches (id) ON DELETE CASCADE,
  revision     INTEGER NOT NULL,
  start_cursor INTEGER NOT NULL,
  combo_count  INTEGER NOT NULL,              -- size of the combo list when leased
  leased_at    INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  state        TEXT    NOT NULL DEFAULT 'leased' CHECK (state IN ('leased', 'processing', 'done')),
  message      TEXT
);

CREATE TABLE runner_job_pairs (                -- the exact dates leased, in order
  job_id   TEXT    NOT NULL REFERENCES runner_jobs (id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  out_date TEXT    NOT NULL,
  back_date TEXT   NOT NULL DEFAULT '',
  PRIMARY KEY (job_id, position)
);

-- One row: when the runner last asked for work / reported. Feeds the
-- "checks have stopped" alert in step 4.
CREATE TABLE runner_status (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  last_poll_at   INTEGER NOT NULL DEFAULT 0,
  last_report_at INTEGER NOT NULL DEFAULT 0,
  last_ok_at     INTEGER NOT NULL DEFAULT 0,  -- last report with at least one successful search
  last_error     TEXT
);
INSERT INTO runner_status (id) VALUES (1);

-- ---------- saved lookups (from the PC app, viewable on the phone) ----------
CREATE TABLE lookups (
  id           TEXT    PRIMARY KEY,           -- random UUID
  created_at   INTEGER NOT NULL,
  origin       TEXT    NOT NULL,
  destination  TEXT    NOT NULL,
  currency     TEXT    NOT NULL,
  out_from     TEXT    NOT NULL,
  out_to       TEXT    NOT NULL,
  back_from    TEXT,
  back_to      TEXT,
  request_json TEXT    NOT NULL,              -- exact search used (a record of the past, not live settings)
  total        INTEGER NOT NULL,
  checked      INTEGER NOT NULL,
  best_price   REAL,
  complete     INTEGER NOT NULL CHECK (complete IN (0, 1))
);
CREATE INDEX lookups_created ON lookups (created_at);

CREATE TABLE lookup_cells (
  lookup_id    TEXT    NOT NULL REFERENCES lookups (id) ON DELETE CASCADE,
  out_date     TEXT    NOT NULL,
  back_date    TEXT    NOT NULL DEFAULT '',
  status       TEXT    NOT NULL CHECK (status IN ('ok', 'none', 'error')),
  price        REAL,
  message      TEXT,
  options_json TEXT    NOT NULL DEFAULT '[]',
  PRIMARY KEY (lookup_id, out_date, back_date)
);
