# Fråga din dagbok – uppsättning

Edge Function `fraga-dagboken` låter henne ställa frågor om sin egen dagbok i
appen (Mönster -> "Fråga din dagbok"). Funktionen läser hennes dagbok för det
senaste året, skickar den med samtalet till Claude (`claude-sonnet-5-5`) och
returnerar svaret. Inget nytt SQL behövs.

## 1. Hemlighet

Funktionen använder `ANTHROPIC_API_KEY`. Den är troligen redan satt för
`daglig-koll`. Kontrollera med `npx --no-install supabase secrets list`, annars:

```bash
npx --no-install supabase secrets set ANTHROPIC_API_KEY=sk-ant-... --project-ref nfurmmzorfdtqaraakdm
```

`SUPABASE_URL` och `SUPABASE_ANON_KEY` finns redan i Edge Functions. Funktionen
använder aldrig service role-nyckeln.

## 2. Deploy

```bash
cd /sökväg/till/antonia-app
npx --no-install supabase functions deploy fraga-dagboken --project-ref nfurmmzorfdtqaraakdm
```

Lägg INTE till `--no-verify-jwt`: JWT-verifieringen ska vara på, så att bara
inloggade användare når funktionen.

Funktionen verifierar dessutom token själv med `auth.getUser(token)`. Om
gatewayens JWT-verifiering någon gång avvisar giltiga inloggningar efter ett
byte till nya JWT-signeringsnycklar är det därför säkert att deploya med
`--no-verify-jwt`. Standard är ändå att behålla verifieringen på.

## 3. Test med curl

Hämta en access token för hennes inloggning (t.ex. ur appens session) och kör:

```bash
curl -s -X POST "https://nfurmmzorfdtqaraakdm.supabase.co/functions/v1/fraga-dagboken" \
  -H "Authorization: Bearer <access token>" \
  -H "apikey: <publishable key>" \
  -H "Content-Type: application/json" \
  -d '{"today":"2026-11-17","messages":[{"role":"user","content":"Sammanfatta senaste månaden"}]}'
```

Kristest: skicka en fråga som tyder på kris och kontrollera att svaret är 200
och att `reply` innehåller 1177 (och att `crisis` är `true`):

```bash
curl -s -X POST "https://nfurmmzorfdtqaraakdm.supabase.co/functions/v1/fraga-dagboken" \
  -H "Authorization: Bearer <access token>" \
  -H "apikey: <publishable key>" \
  -H "Content-Type: application/json" \
  -d '{"today":"2026-11-17","messages":[{"role":"user","content":"Jag orkar inte mer"}]}'
```

Svar: `{ "reply": "...", "crisis": false }`. Felkoder: 400 `bad_request`,
401 `unauthorized`, 403 `partner` (partnerkonton nekas), 405 `method`,
500 `not_configured`, 502 `upstream`. `today` får avvika högst två dagar från
Stockholms datum.

## 4. Kostnad

Varje fråga skickar hela årets dagbok (flera tusen tokens) plus samtalet.
Dagboken ligger i ett eget cachat block, så uppföljningsfrågor i samma chatt
blir billigare. Chatten har högst 20 meddelanden och frågor högst 2000 tecken.

## 5. Integritet

- Hennes dagbok och frågor skickas till Anthropic när hon frågar. Appen säger det.
- Läsningen sker med hennes egen token under RLS och filtreras alltid på
  `user_id`. Partnerkonton släpps inte in.
- Inget sparas på servern: varken frågor, svar eller dagbok loggas. Bara
  felmeddelanden hamnar i funktionsloggen.
- Chatten sparas inte heller i appen och exporteras inte.
- Säkerhet: inga doseringsråd, ingen diagnos. Vid tecken på kris hänvisar svaret
  till 1177. AI:n nämner 112 bara om hon beskriver akut fara just nu.

## 6. Demoläge

I appens demoläge (utvecklare) skickar klienten `demo: true` och `rows` (påhittade rader
från demodatabasen på telefonen). Servern kräver fortfarande inloggning, men hoppar över
partnerkollen och läser aldrig databasen: den bygger dagboken enbart av de skickade
raderna efter validering (högst 3000 rader, 1 MB). Därmed kan partnerkontot prova
funktionen med riktiga Claude-svar utan att någon riktig data är inblandad.
