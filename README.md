# Farewatch v2

- `engine/` Python flight engine. Shared: PC lookup (Tauri sidecar) and watch checks (GitHub Actions, `farewatch_engine/runner.py`).
- `app/` Tauri + React + TypeScript app. Talks to data only through `app/src/backend/`.
- `server/` Watch server: Cloudflare Worker (TypeScript) + D1 database. Watches, prices, saved lookups, settings.
- `.github/workflows/watch.yml` Checks watches about once an hour on GitHub's free runners.

Everything is free: Cloudflare free plan, GitHub Actions on a public repo. No secrets are stored in this folder.

## One-time setup (Command Prompt)

Check what you have:

    node --version
    py -3.12 --version
    rustc --version
    git --version

Missing ones: Node.js LTS (nodejs.org), Python 3.12 (python.org, tick "py launcher"),
Rust (rustup.rs; it also asks for "Visual Studio C++ Build Tools" - install them), Git (git-scm.com).

## 1. Watch server (Cloudflare)

    cd /d C:\Users\jaspi\Documents\Farewatch\v2\server
    npm install
    npm test
    npx wrangler login
    npx wrangler d1 create farewatch-v2

Copy the `database_id` it prints into `server\wrangler.jsonc` (replace `PASTE-DATABASE-ID-HERE`). Then:

    npm run db:migrate
    npm run deploy

`deploy` prints the server address, for example `https://farewatch-v2.farewatch.workers.dev`. Now set the two secrets.
Make a runner token (copy the output, you need it twice):

    node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
    npx wrangler secret put RUNNER_TOKEN
    npx wrangler secret put ADMIN_PASSWORD

`ADMIN_PASSWORD` is the app password (12+ characters). Changing it later signs out every device.
Check: open `<server address>/api/health` in a browser. It shows `{"ok":true,...}`.

## 2. Watch checks (GitHub Actions)

The code lives in the public GitHub repo `br0wnv3n0m/farewatch-v2` (public = free Actions minutes).
To get a local copy that can push changes: `git clone https://github.com/br0wnv3n0m/farewatch-v2.git`.

On github.com: repo > Settings > Secrets and variables > Actions > New repository secret:
- `FAREWATCH_URL` = the server address (no slash at the end)
- `FAREWATCH_RUNNER_TOKEN` = the runner token from step 1

Then Actions > "Watch check" > Run workflow, to test once. After that it runs by itself.

GitHub's own 15-minute schedule is unreliable on free public repos (often hours late). So the server cron
(every 30 min) starts the workflow itself when a watch is due. It needs a GitHub token:
github.com > your photo > Settings > Developer settings > Personal access tokens > Fine-grained tokens >
Generate new token. Repository access: Only select repositories > `farewatch-v2`. Permissions > Repository >
Actions: Read and write (nothing else). Copy the token, then:

    cd /d C:\Users\jaspi\Documents\Farewatch\v2\server
    npx wrangler secret put GITHUB_TOKEN

When the token expires, make a new one and run the same command. The app (Settings) and the
"checks have stopped" email show it when GitHub refuses the token.
GitHub pauses scheduled workflows in a public repo after 60 days with no commits. The server emails a warning
at 50 days (push any commit to reset the timer) and a "checks have stopped" email if it happens; then click
"Enable workflow" in the Actions tab.

## 2b. Alert emails (Resend, free plan)

The sender is set in `server\wrangler.jsonc` (`EMAIL_FROM`, domain verified in Resend). Make an API key on
resend.com > API Keys > Create (permission: Sending access), then:

    cd /d C:\Users\jaspi\Documents\Farewatch\v2\server
    npx wrangler secret put RESEND_API_KEY

In the app: Settings > Alert email > Send test email. What the server sends:
- Fare digest when a watch has fares with price + reserve <= budget: new fares, or a drop of at least 2% when the
  last alert for those dates is over 24 hours old. Watches with checked bags only alert when "alert even though bag
  costs are unverified" is on. Fare links in the email expire after 30 days.
- "Checks have stopped" when the runner has not asked for work for 3 hours, or there was no successful search for
  6 hours, while a watch is active. A reminder every 3 days, and an email when checks work again.
The cron (every 30 min) also retries failed emails and removes old data.

## 3. App

    cd /d C:\Users\jaspi\Documents\Farewatch\v2\engine
    build-engine.cmd

    cd /d C:\Users\jaspi\Documents\Farewatch\v2\app
    npm install
    npm run tauri icon app-icon.png
    npm run tauri dev

In the app: Settings > Watch server > server address + password > Sign in.
First `tauri dev` compiles Rust and takes several minutes. Later runs are fast.
Rebuild the engine (`build-engine.cmd`) after any change in `engine/`.

The PC app may only connect to `https://*.workers.dev` addresses. To use your own domain for the server later,
add it to `connect-src` in `app\src-tauri\tauri.conf.json`.

## 4. Phone (iPhone home screen)

The server Worker also serves the phone version of the app: `npm run deploy` (in `server`) builds it
(`app\dist-web`) and uploads it with the server. Address: `https://farewatch-v2.farewatch.workers.dev`.

On the iPhone: open that address in Safari > Share > Add to Home Screen > Add. Open Farewatch from the
home screen, enter the app password in Settings > Sign in. The phone shows watches, price history and
lookups saved by the PC app; live lookup runs only in the PC app.

## Other commands

    app:     npm run dev          UI in a normal browser, fake prices and fake server (demo mode)
    app:     npm run typecheck    TypeScript check
    app:     npm run tauri build  Windows installer in app\src-tauri\target\release\bundle\nsis
    server:  npm test             server tests (in-memory database)
    server:  npm run typecheck
    server:  npm run deploy       after any change in server\src or app\src (also builds the phone app)
    app:     npm run build:web    phone app only, into app\dist-web
    engine:  .venv\Scripts\python -m unittest discover -s tests -t .

Database changes go in a new file `server\migrations\0002_....sql`, then `npm run db:migrate`.

## Local server test (no Cloudflare)

Create `server\.dev.vars` (never committed) with two lines:

    ADMIN_PASSWORD=local test password
    RUNNER_TOKEN=rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr

Then `npm run db:migrate:local` and `npm run dev` (server on http://localhost:8787).
In another window: `cd ..\app` then `npm run dev -- --mode web`, open http://localhost:1420 and sign in with
`http://localhost:8787`.

## Manual engine tests (no app)

    cd /d C:\Users\jaspi\Documents\Farewatch\v2\engine
    echo {"origin":"YVR","destination":"DEL","outDates":{"from":"2027-01-12","to":"2027-01-12"},"backDates":null,"blockedCountries":["US"]} | dist\farewatch-engine.exe lookup

Runner without the server: put `{"config":{...},"pairs":[{"out":"2027-01-12","back":null}]}` in `job.json`, then

    .venv\Scripts\python -m farewatch_engine.runner --probe job.json --output out.json
