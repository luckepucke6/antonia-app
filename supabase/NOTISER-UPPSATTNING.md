# Notiser + daglig AI-koll: uppsättning

Instruktion till den som lägger ut det här (en session på ägarens dator, med
tillgång till Supabase-projektet `antonia-dagbok`). Inget av det här är
provkört mot det riktiga projektet, se "Ej testat" längst ner.

**Läs först:** den dagliga kollen skickar hennes dagbok, **inklusive hennes
egna anteckningar**, till Anthropics API (Claude) en gång per dag. Hon ska vara
införstådd med det och OK med det innan du slår på schemat. Och på iPhone
fungerar notiser bara när appen är **tillagd på hemskärmen** (iOS 16.4 eller
nyare); i vanliga Safari kommer de inte fram.

## Filer

- `supabase/notiser.sql`: tabeller, partnervy (`partner_overview()`), cron-mall
- `supabase/functions/daglig-koll/index.ts` och `logic.ts`: Edge-funktionen

## Steg

1. **Kör `supabase/notiser.sql`** i SQL Editor (efter `schema.sql`). Den går att
   köra om. Avsnitt d) är bortkommenterat och körs inte här.

2. **Skapa VAPID-nycklar** (på din dator, nycklarna sparas inte i repot):

   ```bash
   npx web-push generate-vapid-keys
   ```

   Du får en *Public Key* och en *Private Key* (URL-säker base64).

3. **Sätt funktionens hemligheter** (bara namnen här, värdena skriver du själv):

   ```bash
   supabase secrets set \
     ANTHROPIC_API_KEY=... \
     VAPID_PUBLIC_KEY=... \
     VAPID_PRIVATE_KEY=... \
     VAPID_SUBJECT=mailto:<en-adress-som-fungerar> \
     CRON_SECRET=<ett långt slumpmässigt värde>
   ```

   `SUPABASE_URL` och `SUPABASE_SERVICE_ROLE_KEY` finns redan i Edge-miljön.
   Saknas någon hemlighet svarar funktionen 500, och vilka som saknas står i
   funktionens logg (inte i svaret).

4. **Lägg ut funktionen med JWT-kontrollen avstängd**, eftersom den själv
   kontrollerar headern `x-cron-secret`:

   ```bash
   supabase functions deploy daglig-koll --no-verify-jwt --project-ref <PROJECT_REF>
   ```

   (Alternativ: `[functions.daglig-koll]` med `verify_jwt = false` i
   `supabase/config.toml`.)

5. **Lägg in partnern** (kör i SQL Editor, byt platshållarna mot de två
   användar-id:na från Authentication > Users):

   ```sql
   insert into public.shares (owner, viewer)
   values ('<HENNES-USER-ID>', '<HANS-USER-ID>')
   on conflict do nothing;
   ```

6. **Appen:** klistra in den **publika** VAPID-nyckeln i konstanten
   `VAPID_PUBLIC_KEY` i `index.html`, och höj `CACHE_NAME` i `sw.js`
   (`-vN` till `-vN+1`) så att den nya versionen når telefonerna. Lägg ut appen.
   Den privata nyckeln får aldrig hamna i repot.

7. **Provkör funktionen** (byt `<PROJECT_REF>` och `<CRON_SECRET>`):

   ```bash
   # a) Torrkörning: kör logiken för alla, anropar Claude, skickar och skriver INGET
   curl -s -X POST https://<PROJECT_REF>.supabase.co/functions/v1/daglig-koll \
     -H 'x-cron-secret: <CRON_SECRET>' -H 'Content-Type: application/json' \
     -d '{"dry": true}'

   # b) Testnotis till alla prenumerationer (hon har först slagit på notiser i appen)
   curl -s -X POST https://<PROJECT_REF>.supabase.co/functions/v1/daglig-koll \
     -H 'x-cron-secret: <CRON_SECRET>' -H 'Content-Type: application/json' \
     -d '{"test": true}'
   ```

   Torrkörningens svar innehåller vad som skulle ha hänt, även AI-texterna, så
   behandla det som privat. Testsvaret ger `subs`, `sent`, `removed`, `failed`.

8. **Schemalägg varje timme:** i SQL Editor, använd mallen i avsnitt d) i
   `notiser.sql` (aktivera `pg_cron` och `pg_net`, lägg `CRON_SECRET` i Vault,
   byt `<PROJECT_REF>` och `<CRON_SECRET>`). Funktionen avgör själv, i svensk
   tid, vad som ska göras just den timmen.

## Vad appen förväntar sig

- Tabellen `push_subscriptions(user_id default auth.uid(), endpoint pk, p256dh,
  auth, created_at)`. Appen upsertar `{endpoint, p256dh, auth}` och raderar på
  `endpoint`. RLS: bara egna rader.
- Tabellen `notify_log(user_id, kind, day, created_at, pk(user_id, kind, day))`,
  bara för servern (RLS på, inga rättigheter för appen).
- Push-innehåll som JSON `{title, body, view}`. `view` är `medicin`, `maende`
  eller `idag` och öppnar motsvarande vy.
- Raden `notes` med nyckel `signal`, skriven av funktionen med fälten `date`,
  `dags`, `sakerhet`, `liknar`, `text`, `text_partner`, `updatedAt`. Den synkas
  ner till appen som vilken annan rad som helst.
- RPC `partner_overview()` för partnern. Den lämnar bara ut dagens "helhet"
  (ett tal), om tablett togs, omgångarnas datum och `text_partner`, aldrig
  anteckningar, taggar, enskilda skattningar eller `text`. Policyn
  `records_viewer_select` tas bort av `notiser.sql`.

## Så fungerar kollen

Svensk tid, högst en gång per användare, sort och dag (styrs av `notify_log`):
`med` kl. 08-11 (aktiv omgång, ingen dos idag), `logg` kl. 20-22 (inget mående
idag), `ai` kl. 21-23 (ingen aktiv omgång och mående loggat idag eller igår).
En AI-signal skickas bara om ingen signal skickats de fyra senaste dagarna.
Notiser går till alla hennes prenumerationer och, för signalen, även till
partnern. Prenumerationer som svarar 404/410 tas bort.

## Ej testat

- Inget har körts mot det riktiga Supabase-projektet (ingen åtkomst härifrån):
  SQL-filen är inte körd, funktionen är inte utlagd, cron är inte schemalagd.
- Inget riktigt anrop till Claude är gjort. `fallbacks: "default"` ihop med
  strukturerad utdata (`output_config.format`) och modellen `claude-opus-5-5`
  är inte provat mot API:et. Svarar API:et med 400 här, ta först bort
  `fallbacks`/`betas` och prova igen.
- Inget riktigt push-utskick till Apples eller Googles push-tjänst. Kryptering
  och sändning är bara provade mot en lokal server.
- Funktionen är inte körd i Supabase Edge-miljön, bara i Deno 2 lokalt.
- Telefonen: att notisen faktiskt dyker upp och öppnar rätt vy är inte provat.
