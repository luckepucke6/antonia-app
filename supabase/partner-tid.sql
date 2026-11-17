-- Partnervyn: tidpunkt för senaste loggningen (fältet last_mood i
-- partner_overview()). Kör bara den här filen i SQL Editor; den ersätter
-- funktionen och ändrar inget annat. Samma funktion finns i notiser.sql.

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
  v_last    jsonb;
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

  -- Senaste loggade dagen: när hon sparade den (appens updatedAt) och när den
  -- kom fram till servern (updated_at). Bara tidpunkter, inga värden.
  select jsonb_build_object(
           'date',      r.key,
           'logged_at', r.data -> 'updatedAt',
           'synced_at', r.updated_at)
  into v_last
  from public.records r
  where r.user_id = v_owner
    and r.store = 'mood'
    and r.deleted_at is null
    and (r.data ->> 'deletedAt') is null
    and r.key ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
  order by r.key desc
  limit 1;

  return jsonb_build_object(
    'owner',   v_owner,
    'last_mood', v_last,    -- null om inget är loggat
    'days',    v_days,
    'areas7',  v_areas7,
    'courses', v_courses,
    'signal',  v_signal,    -- null om ingen koll har körts
    'helps',   v_helps);    -- null om hon inte delar
end;
$$;
