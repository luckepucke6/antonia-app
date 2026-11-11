# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"Antonias dagbok <3" — a private health-tracking PWA built for one person's
iPhone. Installed via Safari "Add to Home Screen",
runs offline. **IndexedDB on the phone is the source of truth**; when she is
logged in, data also syncs to a Supabase project (`antonia-dagbok`, region
Stockholm) as backup and for a second device. The JSON export/import in
Settings still works as a manual backup.

UI text is in Swedish; keep it that way.

## Constraints (deliberate, don't "modernize" away)

- **Vanilla HTML/CSS/JS, no frameworks, no build step.** The app must open by
  serving the folder statically. Do not introduce npm dependencies, bundlers,
  TypeScript, or a framework.
- `index.html` is intentionally self-contained: CSS lives in one `<style>`
  block and all app JS in one `<script>` block. `sw.js` and `manifest.json`
  must stay separate files (service workers can't be inline; the manifest is
  linked). `vendor/supabase.js` is supabase-js 2.119.0 (UMD), vendored and
  precached so nothing is loaded from a CDN at runtime.

## Architecture

Everything of substance is in `index.html`, organized into four labeled JS
sections:

- **(a) Navigation** — `showView(name, title)` toggles `.active` on
  `<section class="view">` elements and the matching `.tab` button, and updates
  the sticky header. The bottom tab bar uses event delegation on `#tabbar`;
  each `.tab` carries `data-view` and `data-title`. No router.
- **(b) IndexedDB module** — DB `antonia-dagbok`, three object stores created in
  `onupgradeneeded`:
  - `mood` — `keyPath: "date"` (YYYY-MM-DD); one row per day, `put` is an upsert.
  - `medication` — `keyPath: "id", autoIncrement: true` (multiple doses/day).
  - `bleeding` — `keyPath: "id", autoIncrement: true` (multiple entries/day).
  Generic helpers `addRecord / getRecord / getAll / clearStore` wrap an `_tx()`
  transaction helper. **Views should call these helpers rather than touching
  IndexedDB directly.** They're also exposed as `window.db` for console testing.
- **(c) Export / Import** — export reads all stores into
  `{ app, version, exportedAt, mood[], medication[], bleeding[] }` and downloads
  JSON; import **replaces** all data (clears then refills each store after a
  `confirm`). This backup format is the migration path between phones, so keep
  it backward-compatible.
- **(d) Service worker registration** — registers `sw.js` on load.

`sw.js` is cache-first with network fallback over a static precache list
(`CACHE_NAME`). User data is never in the cache (it's in IndexedDB).

There is a fourth store, `courses` (`keyPath: "omgangId"`), for medication
courses. Later sections in the script: (e) Mående, (f) Medicin, (g) Blödningar,
(h) Idag, (i) Sync.

## Sync (section i)

- Server: one generic table `records (user_id, store, key, data jsonb,
  updated_at, deleted_at)` plus `shares (owner, viewer)` for read-only access.
  Schema and RLS policies live in `supabase/schema.sql`. Sign-ups are disabled;
  app logins are created by hand in the Supabase dashboard.
- `addRecord` stamps `updatedAt`, `dirty = 1` and (medication/bleeding) a `uid`.
  `deleteRecord` is a **soft delete** (`deletedAt` tombstone); `getAll` /
  `getRecord` hide tombstones. Use `_getAllRaw` / `_putRaw` only in sync code.
- Sync key per store: `mood` → `date`, `courses` → `omgangId`,
  `medication`/`bleeding` → `uid` (the local autoIncrement `id` differs per
  device and is never sent).
- `sync()` pulls rows newer than the cursor (server `updated_at`), then pushes
  dirty records. Conflict rule: latest `updatedAt` wins. State lives in
  `localStorage` (`sync-user`, `sync-cursor`, `sync-last`).
- Only the publishable key (`sb_publishable_…`) may be in the repo. Never commit
  a secret key, access token or exported backup.
- Dates: always use `todayISO()` / `isoFromDate()` (local time). Never
  `toISOString().slice(0, 10)` — it is UTC and gives the wrong day in Sweden.

## Critical gotchas

- **Bump `CACHE_NAME` in `sw.js`** (`-v1` → `-v2` …) on *every* change to a
  precached file, or the old cached version keeps being served.
- **iOS requires a secure context** (https or localhost) for the service worker
  to activate. Over plain LAN `http://192.168.x.x` the app still installs and
  IndexedDB works, but offline caching does not. Test real offline via an https
  tunnel (`npx cloudflared tunnel --url http://localhost:8000`) or a static host.
- When bumping DB schema, increment `DB_VERSION` and add stores/indexes inside
  `onupgradeneeded` (guard with `objectStoreNames.contains`).

## Commands

```bash
# Serve locally (service worker works on localhost)
python3 -m http.server 8000      # then open http://localhost:8000

# Regenerate app icons (pure stdlib, no deps) into ./icons
python3 gen_icons.py
```

There is no test suite or linter. Manual verification: DevTools → Application
(manifest loaded, service worker "activated", DB `antonia-dagbok` has 4 stores),
then exercise export/import in the Settings (Inställningar) view.
