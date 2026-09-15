begin;

create table public.app_owner (
  singleton boolean primary key default true check (singleton),
  user_id uuid not null unique references auth.users(id) on delete cascade
);
create table public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 250),
  storage_path text not null unique,
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 41943040),
  page_count integer not null check (page_count between 1 and 100000),
  current_page integer not null default 1 check (current_page > 0 and current_page <= page_count),
  zoom double precision not null default 1 check (zoom between 0.6 and 2.5),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index projects_owner_updated on public.projects(owner_id, updated_at desc);
create table public.notes (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  page integer not null check (page > 0),
  quote text not null default '' check (char_length(quote) <= 20000),
  body text not null default '' check (char_length(body) <= 50000),
  rects jsonb not null default '[]' check (jsonb_typeof(rects) = 'array' and jsonb_array_length(rects) <= 1000),
  color text not null default 'sage' check (color in ('sage','yellow','rose','blue')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (length(quote) > 0 or length(body) > 0)
);
create index notes_project_created on public.notes(project_id, created_at desc);
create table public.ocr_pages (
  project_id uuid not null references public.projects(id) on delete cascade,
  page integer not null check (page > 0),
  words jsonb not null check (jsonb_typeof(words) = 'array' and jsonb_array_length(words) <= 10000),
  primary key(project_id, page)
);

-- Only the authenticated, owner-checked Edge Function uses these tables.
-- There are deliberately no direct browser database or storage policies.
alter table public.app_owner enable row level security;
alter table public.projects enable row level security;
alter table public.notes enable row level security;
alter table public.ocr_pages enable row level security;
revoke all on public.app_owner, public.projects, public.notes, public.ocr_pages from anon, authenticated;
grant all on public.app_owner, public.projects, public.notes, public.ocr_pages to service_role;

create function public.check_library_quota() returns trigger language plpgsql set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(106106);
  if (select coalesce(sum(size_bytes), 0) from public.projects) + new.size_bytes > 996147200 then
    raise exception 'Library storage is full. Delete a document before importing another.';
  end if;
  return new;
end;
$$;
create trigger enforce_library_quota before insert on public.projects for each row execute function public.check_library_quota();
revoke all on function public.check_library_quota() from public, anon, authenticated;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('pdfs', 'pdfs', false, 41943040, array['application/pdf']);
commit;
