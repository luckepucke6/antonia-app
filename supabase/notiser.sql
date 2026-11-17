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
--    ALDRIG: anteckningar, taggar, enskilda skattningar eller hennes "text" –
--    utom "Det här hjälper mig" (fältet helps) när hon själv slagit på delning.
-- ---------------------------------------------------------------------------
drop policy if exists records_viewer_select on public.records;

-- Helhet för en dag = medel av "tyngden" i de skattningar som finns:
--   humor, energi, sleepQuality: högt är bra  → tyngd = 6 - värde
--   alla andra:                  högt är värre → tyngd = värde
-- (samma regel som i appen och i Edge-funktionen). Null om inga skattningar.
-- Dessutom returneras areas7: medel per område (kanslor, kropp, somn) över de
-- senaste 7 dagarna (svensk tid) och antal loggade dagar. Bara sammanställda
-- snitt, aldrig enskilda skattningar per dag.
create or replace function public.partner_overview() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_owner   uuid;
  v_from    text;
  v_days    jsonb;
  v_courses jsonb;
  v_signal  jsonb;
  v_areas7  jsonb;
  v_helps   text;
  v_share   jsonb;
  v_helps_n jsonb;
  v_heavy   boolean;
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
           jsonb_build_object('date', t.d, 'level', t.level,
                              'med', t.med)
           order by t.d), '[]'::jsonb)
  into v_days
  from (
    select coalesce(m.d, x.d) as d, m.level,
           (x.d is not null) as med
    from mood m
    full join med x on x.d = m.d
  ) t;

  -- Medel per område över de senaste 7 dagarna (idag och 6 dagar bakåt, svensk
  -- tid). Samma vändregel (6 - v) som ovan, men bara sammanställt: inga värden
  -- per dag lämnas ut.
  select jsonb_build_object(
           'kanslor', round(avg(w.v) filter (where w.k in ('humor', 'irritabilitet',
                       'angest', 'sjalvkritik', 'kanslighet', 'intensitet', 'delusion')), 1),
           'kropp',   round(avg(w.v) filter (where w.k in ('energi', 'magbesvar', 'stress')), 1),
           'somn',    round(avg(w.v) filter (where w.k = 'sleepQuality'), 1),
           'logged',  count(distinct w.d))
  into v_areas7
  from (
    select r.key as d, e.key as k,
           case when e.key in ('humor', 'energi', 'sleepQuality')
                then 6 - e.value::numeric
                else e.value::numeric end as v
    from public.records r
    cross join lateral jsonb_each_text(
           case when jsonb_typeof(r.data -> 'scores') = 'object'
                then r.data -> 'scores' else '{}'::jsonb end) e
    where r.user_id = v_owner
      and r.store = 'mood'
      and r.deleted_at is null
      and (r.data ->> 'deletedAt') is null
      and r.key ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      and r.key >= to_char((now() at time zone 'Europe/Stockholm')::date - 6, 'YYYY-MM-DD')
      and e.value ~ '^[1-5](\.[0-9]+)?$'
  ) w;

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

  -- "Det här hjälper mig": bara om hon slagit på delning (notes-raden
  -- 'helps-share', data.on = true) OCH det är en tyngre period just nu:
  -- en aktiv omgång, ELLER en signal (dags = true) som är högst två dagar
  -- gammal, ELLER minst 2 av de 3 senaste dagarna (svensk tid) med nivå >= 3.5.
  -- Egen text till partnern går före listan i notes-raden 'helps'. Tom text
  -- blir null. Inget annat ur notes.
  select r.data into v_share
  from public.records r
  where r.user_id = v_owner
    and r.store = 'notes'
    and r.key = 'helps-share'
    and r.deleted_at is null
    and (r.data ->> 'deletedAt') is null;

  v_heavy := exists (
      select 1 from jsonb_array_elements(v_courses) c
      where (c -> 'active') = 'true'::jsonb)
    or (v_signal is not null
        and (v_signal -> 'dags') = 'true'::jsonb
        and (v_signal ->> 'date') >=
            to_char((now() at time zone 'Europe/Stockholm')::date - 2, 'YYYY-MM-DD'))
    or (select count(*) from jsonb_array_elements(v_days) d
        where (d ->> 'date') >=
              to_char((now() at time zone 'Europe/Stockholm')::date - 2, 'YYYY-MM-DD')
          and (d ->> 'level') is not null
          and (d ->> 'level')::numeric >= 3.5) >= 2;

  if v_heavy and v_share is not null and (v_share -> 'on') = 'true'::jsonb then
    v_helps := nullif(btrim(coalesce(v_share ->> 'text', '')), '');
    if v_helps is null then
      select r.data into v_helps_n
      from public.records r
      where r.user_id = v_owner
        and r.store = 'notes'
        and r.key = 'helps'
        and r.deleted_at is null
        and (r.data ->> 'deletedAt') is null;
      v_helps := nullif(btrim(coalesce(v_helps_n ->> 'text', '')), '');
    end if;
  end if;

  return jsonb_build_object(
    'owner',   v_owner,
    'days',    v_days,
    'areas7',  v_areas7,
    'courses', v_courses,
    'signal',  v_signal,    -- null om ingen koll har körts
    'helps',   v_helps);    -- null om hon inte delar
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
