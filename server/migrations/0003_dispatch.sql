-- Step 5: the Worker cron starts the GitHub workflow when a watch is due
-- (GitHub's own schedule is often hours late on free public repos).
ALTER TABLE runner_status ADD COLUMN dispatch_at    INTEGER NOT NULL DEFAULT 0; -- last start request sent to GitHub
ALTER TABLE runner_status ADD COLUMN dispatch_error TEXT;                       -- last failed start request, NULL when fine
