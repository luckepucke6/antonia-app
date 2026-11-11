-- Antonias dagbok – databasschema för Supabase.
-- Körs EN gång i ett nytt projekt (SQL Editor eller Management API).
--
-- Appen sparar allt lokalt i telefonen och synkar hit. En enda generell
-- tabell: varje rad är en post ur en av appens "stores" (mood, medication,
-- bleeding, courses). Själva innehållet ligger i "data" (jsonb), så appen kan
-- få nya fält utan att databasen behöver ändras.

create table public.records (
  user_id    uuid        not null default auth.uid()
                         references auth.users (id) on delete cascade,
  store      text        not null,
  key        text        not null,
  data       jsonb       not null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (user_id, store, key)
);

-- Synken hämtar "allt som ändrats sedan sist" per användare.
create index records_user_updated_idx on public.records (user_id, updated_at);

-- Vem som får LÄSA någon annans dagbok (owner = den som loggar,
-- viewer = den som får titta). Rader läggs in för hand av projektägaren.
create table public.shares (
  owner  uuid not null references auth.users (id) on delete cascade,
  viewer uuid not null references auth.users (id) on delete cascade,
  primary key (owner, viewer)
);

-- updated_at sätts alltid av servern, så synk-markören inte beror på
-- telefonens klocka.
create function public.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger records_set_updated_at
  before insert or update on public.records
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Åtkomst: radnivåregler (RLS). Utan inloggning syns ingenting.
-- ---------------------------------------------------------------------------
alter table public.records enable row level security;
alter table public.shares  enable row level security;

revoke all on public.records, public.shares from anon, authenticated;
grant select, insert, update on public.records to authenticated;
grant select on public.shares to authenticated;

-- Ägaren läser och skriver sina egna rader. (Ingen delete: appen raderar
-- "mjukt" genom att sätta deleted_at.)
create policy records_owner_select on public.records
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy records_owner_insert on public.records
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy records_owner_update on public.records
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- Den som står som viewer i shares får LÄSA ägarens rader, inget annat.
create policy records_viewer_select on public.records
  for select to authenticated
  using (exists (
    select 1 from public.shares s
    where s.owner = records.user_id
      and s.viewer = (select auth.uid())
  ));

-- Man ser bara delningar man själv ingår i. Ingen kan ändra dem via appen.
create policy shares_select on public.shares
  for select to authenticated
  using ((select auth.uid()) in (owner, viewer));
