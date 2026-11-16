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
(h) Idag (incl. the support card for heavy periods), (i) Sync, (j) Mönster
(month calendar coloured by a chosen metric, bar statistics built on the share
of "heavy days" — see `dayClass` — and a printable report). There is also a fifth
store, `notes` (`keyPath: "key"`). Settings is opened from the gear in the header.

Things that live in existing stores rather than their own:

- `mood` records may carry `tags` (ids from `MOOD_TAGS`, the "Snabbval" chips)
  and `estimated: true` (scores entered afterwards from her old notes; shown
  as such, excluded from the comparisons, cleared when she saves the day).
- `notes` keys: `helps` (support card), `avoid` (the "Undvik" list on Idag) and
  `ppiller:YYYY-MM-DD` (one per started contraceptive pill pack).
- Scales where a high value means more trouble are drawn mirrored in the
  Mående view so the positive end is always on the right. Only the display is
  flipped; stored values keep their meaning.
- Settings has two imports: "Importera" **replaces** everything, "Lägg till
  från fil" (`mergeAll`) only adds what is missing and never overwrites.

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

## Notifications, signal and partner mode

Setup steps (VAPID keys, Edge Function, schedule) are in
`supabase/NOTISER-UPPSATTNING.md`.

- **Web Push**: Settings has a "Notiser" card. The constant `VAPID_PUBLIC_KEY`
  in `index.html` is empty until push is set up (the card then says so); only
  the public key may live in the repo. Subscriptions are upserted into the
  `push_subscriptions` table (endpoint, p256dh, auth); logging out removes the
  device's subscription. `sw.js` has `push` and `notificationclick` handlers;
  the payload is JSON `{ title, body, view }`, and a click focuses the app and
  posts `{type: "open-view", view}` (or opens `./#view`), handled by
  `openViewByName`. On iPhone push only works from the home-screen app.
- **Signal**: `notes` key `signal` = `{ date, dags, sakerhet, liknar, text,
  text_partner }`, written server-side by the Edge Function
  `supabase/functions/daglig-koll` and synced down like any note. Idag shows
  the "Känner du igen det här?" card (`buildSignal`) when it is at most two
  days old, no course is active and "Inte nu" has not been pressed
  (`localStorage` `signal-dismissed`).
- **Partner mode**: if the logged-in user is a `viewer` in `shares`,
  `checkPartner()` fetches a limited overview via the RPC `partner_overview()`
  (a level per day, medication days, courses, `text_partner`) — never notes,
  tags or individual scores. Body class `partner` swaps the tab bar for one
  "Översikt" tab (`view-partner`, `renderPartner`). Nothing goes into
  IndexedDB; the overview is cached in `localStorage` (`partner-user`,
  `partner-cache`) for offline use, and `sync()` is skipped while in partner mode.

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
