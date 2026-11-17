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
GitHub pauses scheduled workflows in a public repo after 60 days with no commits; re-enable it in the Actions tab
(step 4 adds an email alert when checks stop).

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

## Other commands

    app:     npm run dev          UI in a normal browser, fake prices and fake server (demo mode)
    app:     npm run typecheck    TypeScript check
    app:     npm run tauri build  Windows installer in app\src-tauri\target\release\bundle\nsis
    server:  npm test             server tests (in-memory database)
    server:  npm run typecheck
    server:  npm run deploy       after any change in server\src
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
