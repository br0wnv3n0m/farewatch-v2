-- Step 4: fare alert emails, fare links, "checks have stopped" monitor, faster clean-up.
-- Apply with: npm run db:migrate   (only files newer than the last applied one run)

-- Last alert per date combo (v1 rule: new fare, or a drop of 2%+ and the last alert over 24 h ago).
CREATE TABLE fare_alerts (
  watch_id  INTEGER NOT NULL REFERENCES watches (id) ON DELETE CASCADE,
  revision  INTEGER NOT NULL,              -- alerts from an older revision do not count
  out_date  TEXT    NOT NULL,
  back_date TEXT    NOT NULL DEFAULT '',
  price     REAL    NOT NULL,              -- price in the last alert
  at        INTEGER NOT NULL,
  PRIMARY KEY (watch_id, out_date, back_date)
);

-- Fare detail pages linked from emails. Only the token hash is stored; links expire after 30 days.
CREATE TABLE fare_links (
  token_hash TEXT    PRIMARY KEY,          -- SHA-256 of the token in the link
  watch_id   INTEGER NOT NULL REFERENCES watches (id) ON DELETE CASCADE,
  data_json  TEXT    NOT NULL,             -- saved fare (route, dates, price, itinerary). No email, no budget.
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX fare_links_expires ON fare_links (expires_at);

-- Every email the server tried to send (newest 200 kept). Shown in Settings.
CREATE TABLE email_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  at       INTEGER NOT NULL,
  kind     TEXT    NOT NULL CHECK (kind IN ('fares', 'stopped', 'resumed', 'repo', 'test')),
  watch_id INTEGER,                         -- no foreign key: the log outlives deleted watches
  ok       INTEGER NOT NULL CHECK (ok IN (0, 1)),
  message  TEXT    NOT NULL
);

-- Random secret for fare link tokens (made on first use). Same alert = same links,
-- so a resent email is byte-for-byte the same and Resend's idempotency key works.
ALTER TABLE settings ADD COLUMN link_secret TEXT;

-- "Checks have stopped" monitor state.
ALTER TABLE runner_status ADD COLUMN repo_commit_at     INTEGER NOT NULL DEFAULT 0; -- newest commit time the runner saw (ms)
ALTER TABLE runner_status ADD COLUMN repo_alert_at      INTEGER NOT NULL DEFAULT 0; -- last "GitHub will pause soon" email
ALTER TABLE runner_status ADD COLUMN outage_since       INTEGER NOT NULL DEFAULT 0; -- 0 = checks are fine
ALTER TABLE runner_status ADD COLUMN outage_reason      TEXT;
ALTER TABLE runner_status ADD COLUMN outage_emailed_at  INTEGER NOT NULL DEFAULT 0;

-- Clean-up runs every 30 min from the cron; these indexes keep it from reading whole tables
-- (D1 free plan: 5 million rows read per day).
CREATE INDEX price_history_at ON price_history (at);
CREATE INDEX runner_jobs_leased ON runner_jobs (leased_at);
CREATE INDEX watch_prices_out ON watch_prices (out_date);
