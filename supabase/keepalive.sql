create table if not exists public.keepalive (
  id int primary key,
  touched_at timestamptz not null default now()
);

insert into public.keepalive (id) values (1) on conflict (id) do nothing;

alter table public.keepalive enable row level security;
drop policy if exists "keepalive read" on public.keepalive;
create policy "keepalive read" on public.keepalive for select to anon, authenticated using (true);
grant select on public.keepalive to anon, authenticated;
