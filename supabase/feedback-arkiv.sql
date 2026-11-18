-- Antonias dagbok – arkivering av förslag (partnervyn).
-- Körs EN gång i SQL Editor, efter fas3.sql. Går att köra om utan skada.
--
-- Partnern kan arkivera ett förslag (öppet eller fixat) så att det försvinner
-- ur hans lista. Raden finns kvar och kan återställas. Hennes egen lista i
-- appen påverkas inte.

alter table public.feedback add column if not exists archived_at timestamptz;

-- Partnern arkiverar (p_archived = true) eller återställer ett förslag.
-- Gör inget om anroparen inte är viewer för förslagets ägare.
drop function if exists public.feedback_archive(text, boolean);
create or replace function public.feedback_archive(p_id text, p_archived boolean default true)
returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update public.feedback f
  set archived_at = case when p_archived then now() else null end
  where f.id = p_id
    and exists (select 1 from public.shares s
                where s.owner = f.user_id
                  and s.viewer = (select auth.uid()));
  -- true om en rad uppdaterades
  return found;
end;
$$;

revoke all on function public.feedback_archive(text, boolean) from public, anon;
grant execute on function public.feedback_archive(text, boolean) to authenticated;
