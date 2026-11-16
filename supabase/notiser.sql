-- Antonias dagbok – notiser (push) + partnervy.
-- Körs EN gång i SQL Editor, EFTER schema.sql. Går att köra om utan skada
-- ("if not exists" / "drop ... if exists" / "create or replace").
--
-- Innehåll:
--   a) push_subscriptions – telefonernas push-prenumerationer
--   b) notify_log         – vilka notiser som redan skickats (bara servern)
--   c) partnervyn         – partnern får inte längre läsa råa rader, bara en
--                           sammanfattning via funktionen partner_overview()
--   d) MALL (bortkommenterad) för att köra Edge-funktionen varje timme
--
-- Se NOTISER-UPPSATTNING.md för hela uppsättningen steg för steg.

-- ---------------------------------------------------------------------------
-- a) Push-prenumerationer. En rad per webbläsare/telefon som sagt ja till
--    notiser. Appen gör upsert på "endpoint" med { endpoint, p256dh, auth }
--    (user_id fylls i av default) och delete på endpoint när hon stänger av.
-- ---------------------------------------------------------------------------
create table if not exists public.push_subscriptions (
  user_id    uuid        not null default auth.uid()
                         references auth.users (id) on delete cascade,
  endpoint   text        primary key,
  p256dh     text        not null,
  auth       text        not null,
  created_at timestamptz not null default now()
);

create index if not exists push_subscriptions_user_idx
  on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;

revoke all on public.push_subscriptions from anon, authenticated;
grant select, insert, update, delete on public.push_subscriptions to authenticated;

-- Man ser och ändrar bara sina egna prenumerationer.
drop policy if exists push_subscriptions_select on public.push_subscriptions;
create policy push_subscriptions_select on public.push_subscriptions
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists push_subscriptions_insert on public.push_subscriptions;
create policy push_subscriptions_insert on public.push_subscriptions
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists push_subscriptions_update on public.push_subscriptions;
create policy push_subscriptions_update on public.push_subscriptions
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists push_subscriptions_delete on public.push_subscriptions;
create policy push_subscriptions_delete on public.push_subscriptions
  for delete to authenticated
  using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- b) Logg över skickade notiser: högst en per (användare, sort, dag).
--    Sorter: 'med', 'logg', 'ai', 'signal'. Bara Edge-funktionen (service
--    role) rör tabellen – RLS är på och inga policys finns, så appen kommer
--    inte åt den.
-- ---------------------------------------------------------------------------
create table if not exists public.notify_log (
  user_id    uuid        not null references auth.users (id) on delete cascade,
  kind       text        not null,
  day        date        not null,
  created_at timestamptz not null default now(),
  primary key (user_id, kind, day)
);

alter table public.notify_log enable row level security;
revoke all on public.notify_log from anon, authenticated;

-- Edge-funktionen kör som service_role. Nya tabeller brukar få de här
-- rättigheterna automatiskt i Supabase, men vi säger det uttryckligen så att
-- det inte hänger på projektets standardinställningar.
grant select, insert, update, delete
  on public.push_subscriptions, public.notify_log to service_role;
grant select, insert, update on public.records to service_role;
grant select on public.shares to service_role;

-- ---------------------------------------------------------------------------
-- c) Partnervyn. Tidigare fick den som står som viewer i shares läsa ägarens
--    rader rakt av – men de innehåller hennes egna anteckningar. Den regeln
--    tas bort. I stället finns en funktion som bara lämnar ut en sammanfattning:
--    dagens "helhet" (ett tal), om tablett togs, omgångarnas datum och den
--    korta partnertexten från den dagliga kollen.
--    ALDRIG: anteckningar, taggar, enskilda skattningar eller hennes "text".
-- ---------------------------------------------------------------------------
drop policy if exists records_viewer_select on public.records;

-- Helhet för en dag = medel av "tyngden" i de skattningar som finns:
--   humor, energi, sleepQuality: högt är bra  → tyngd = 6 - värde
--   alla andra:                  högt är värre → tyngd = värde
-- (samma regel som i appen och i Edge-funktionen). Null om inga skattningar.
create or replace function public.partner_overview() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_owner   uuid;
  v_from    text;
  v_days    jsonb;
  v_courses jsonb;
  v_signal  jsonb;
begin
  -- Vems dagbok får den inloggade titta på? (Finns flera: den första.)
  select s.owner into v_owner
  from public.shares s
  where s.viewer = (select auth.uid())
  order by s.owner
  limit 1;

  if v_owner is null then
    return jsonb_build_object('owner', null);
  end if;

  -- De senaste 400 dagarna, räknat i svensk tid.
  v_from := to_char(
    (now() at time zone 'Europe/Stockholm')::date - 399, 'YYYY-MM-DD');

  with mood as (
    select r.key as d,
           (select round(avg(
                     case when e.key in ('humor', 'energi', 'sleepQuality')
                          then 6 - e.value::numeric
                          else e.value::numeric end), 2)
            from jsonb_each_text(
                   case when jsonb_typeof(r.data -> 'scores') = 'object'
                        then r.data -> 'scores' else '{}'::jsonb end) e
            where e.value ~ '^[1-5](\.[0-9]+)?$') as level
    from public.records r
    where r.user_id = v_owner
      and r.store = 'mood'
      and r.deleted_at is null
      and (r.data ->> 'deletedAt') is null
      and r.key ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      and r.key >= v_from
  ),
  med as (
    select distinct r.data ->> 'date' as d
    from public.records r
    where r.user_id = v_owner
      and r.store = 'medication'
      and r.deleted_at is null
      and (r.data ->> 'deletedAt') is null
      and (r.data ->> 'date') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      and (r.data ->> 'date') >= v_from
  )
  select coalesce(jsonb_agg(
           jsonb_build_object('date', t.d, 'level', t.level, 'med', t.med)
           order by t.d), '[]'::jsonb)
  into v_days
  from (
    select coalesce(m.d, x.d) as d, m.level, (x.d is not null) as med
    from mood m
    full join med x on x.d = m.d
  ) t;

  select coalesce(jsonb_agg(
           jsonb_build_object(
             'startdatum', r.data -> 'startdatum',
             'slutdatum',  r.data -> 'slutdatum',
             'active',     coalesce(r.data -> 'active' = 'true'::jsonb, false))
           order by r.data ->> 'startdatum'), '[]'::jsonb)
  into v_courses
  from public.records r
  where r.user_id = v_owner
    and r.store = 'courses'
    and r.deleted_at is null
    and (r.data ->> 'deletedAt') is null;

  -- Senaste resultatet från den dagliga kollen (notes-raden 'signal').
  -- OBS: fältet "text" (det som är skrivet till henne) lämnas INTE ut.
  select jsonb_build_object(
           'date',         r.data -> 'date',
           'dags',         r.data -> 'dags',
           'sakerhet',     r.data -> 'sakerhet',
           'liknar',       r.data -> 'liknar',
           'text_partner', r.data -> 'text_partner')
  into v_signal
  from public.records r
  where r.user_id = v_owner
    and r.store = 'notes'
    and r.key = 'signal'
    and r.deleted_at is null
    and (r.data ->> 'deletedAt') is null;

  return jsonb_build_object(
    'owner',   v_owner,
    'days',    v_days,
    'courses', v_courses,
    'signal',  v_signal);   -- null om ingen koll har körts
end;
$$;

revoke all on function public.partner_overview() from public, anon;
grant execute on function public.partner_overview() to authenticated;

-- ---------------------------------------------------------------------------
-- d) MALL – KÖRS INTE SOM DEN STÅR. Kopiera, byt ut platshållarna <...> och
--    kör för hand när Edge-funktionen "daglig-koll" är utlagd.
--    Schemalägger ett anrop varje timme (minut 5). Funktionen avgör själv,
--    i svensk tid, om något ska göras den timmen.
--    Hemligheten läggs i Vault så att den inte står i klartext i cron-jobbet.
--    Lägg ALDRIG in riktiga värden i den här filen.
-- ---------------------------------------------------------------------------
-- create extension if not exists pg_cron;
-- create extension if not exists pg_net;
--
-- -- Samma värde som funktionshemligheten CRON_SECRET:
-- select vault.create_secret('<CRON_SECRET>', 'cron_secret');
--
-- select cron.schedule(
--   'daglig-koll',
--   '5 * * * *',
--   $cron$
--   select net.http_post(
--     url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/daglig-koll',
--     headers := jsonb_build_object(
--       'Content-Type', 'application/json',
--       'x-cron-secret',
--       (select decrypted_secret from vault.decrypted_secrets
--        where name = 'cron_secret')),
--     body    := '{}'::jsonb,
--     timeout_milliseconds := 150000
--   );
--   $cron$
-- );
--
-- -- Se att jobbet finns / hur senaste körningarna gick:
-- --   select jobid, jobname, schedule from cron.job;
-- --   select status_code, content, created from net._http_response
-- --     order by created desc limit 5;
-- -- Ta bort jobbet:
-- --   select cron.unschedule('daglig-koll');
