begin;
create table public.practice_settings (
 owner_id uuid primary key references auth.users(id),
 anchor_date date not null default (now() at time zone 'Asia/Taipei')::date,
 synced_at timestamptz, sync_requested boolean not null default true,
 sync_error text, image_total integer not null default 0, image_processed integer not null default 0,
 sheet_synced_at timestamptz, sheet_status text not null default 'pending', sheet_hash text,
 lease_until timestamptz, lease_token uuid
);
create table public.practice_sources (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id),
 source_key text not null, origin text not null, label text not null, content text not null,
 content_hash text not null, updated_at timestamptz not null default now(),
 unique(owner_id,source_key)
);
create table public.practice_cycles (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id),
 starts_on date not null, ends_on date not null, status text not null default 'generating' check(status in ('generating','ready','failed')),
 source_snapshot jsonb, error text, failures integer not null default 0,
 model text, prompt_version text not null default 'expression-v1', created_at timestamptz not null default now(),
 unique(owner_id,starts_on)
);
create table public.practice_exercises (
 id uuid primary key default gen_random_uuid(), cycle_id uuid not null references public.practice_cycles(id) on delete cascade,
 position integer not null check(position between 1 and 60), content jsonb not null, unique(cycle_id,position)
);
create table public.practice_drafts (
 owner_id uuid not null references auth.users(id), exercise_id uuid not null references public.practice_exercises(id) on delete cascade,
 answer text not null default '' check(char_length(answer)<=6000), revision bigint not null default 0,
 completed_at timestamptz, updated_at timestamptz not null default now(), primary key(owner_id,exercise_id)
);
create table public.practice_attempts (
 id uuid primary key, owner_id uuid not null references auth.users(id), exercise_id uuid not null references public.practice_exercises(id) on delete cascade,
 answer text not null check(char_length(answer) between 1 and 6000),
 feedback jsonb, status text not null default 'pending' check(status in ('pending','ready','failed')),
 error text, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index practice_attempts_owner_date on public.practice_attempts(owner_id,created_at desc);
create table public.practice_usage (
 owner_id uuid not null references auth.users(id), day date not null default current_date,
 calls integer not null default 0, input_tokens bigint not null default 0, output_tokens bigint not null default 0,
 primary key(owner_id,day)
);
do $$ declare t text; begin
 foreach t in array array['practice_settings','practice_sources','practice_cycles','practice_exercises','practice_drafts','practice_attempts','practice_usage'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from anon, authenticated',t);
 execute format('grant all on public.%I to service_role',t);
 end loop;
end $$;
create function public.practice_claim(p_owner uuid,p_token uuid) returns boolean language plpgsql set search_path='' as $$
begin
 update public.practice_settings set lease_until=now()+interval '3 minutes',lease_token=p_token
 where owner_id=p_owner and (lease_until is null or lease_until<now());
 return found;
end $$;
create function public.practice_budget(p_owner uuid) returns boolean language plpgsql set search_path='' as $$
begin
 insert into public.practice_usage(owner_id,day,calls) values(p_owner,current_date,1)
 on conflict(owner_id,day) do update set calls=public.practice_usage.calls+1 where public.practice_usage.calls<80;
 return found;
end $$;
create function public.practice_tokens(p_owner uuid,p_input bigint,p_output bigint) returns void language sql set search_path='' as $$
 update public.practice_usage set input_tokens=input_tokens+p_input,output_tokens=output_tokens+p_output where owner_id=p_owner and day=current_date;
$$;
create function public.practice_cycle(p_owner uuid) returns uuid language plpgsql set search_path='' as $$
declare start_date date; result uuid;
begin
 insert into public.practice_settings(owner_id) values(p_owner) on conflict do nothing;
 select anchor_date+(((now() at time zone 'Asia/Taipei')::date-anchor_date)/14)*14 into start_date from public.practice_settings where owner_id=p_owner;
 insert into public.practice_cycles(owner_id,starts_on,ends_on) values(p_owner,start_date,start_date+13) on conflict do nothing;
 select id into result from public.practice_cycles where owner_id=p_owner and starts_on=start_date;
 return result;
end $$;
-- Optimistic concurrency protects drafts edited in two browser tabs.
create function public.practice_save(p_owner uuid,p_exercise uuid,p_answer text,p_revision bigint,p_complete boolean)
returns setof public.practice_drafts language plpgsql set search_path='' as $$
begin
 if not exists(select 1 from public.practice_exercises e join public.practice_cycles c on c.id=e.cycle_id where e.id=p_exercise and c.owner_id=p_owner) then raise exception 'Exercise unavailable'; end if;
 insert into public.practice_drafts(owner_id,exercise_id) values(p_owner,p_exercise) on conflict do nothing;
 return query update public.practice_drafts set answer=p_answer,revision=revision+1,updated_at=now(),completed_at=case when p_complete then now() else completed_at end
 where owner_id=p_owner and exercise_id=p_exercise and revision=p_revision returning *;
end $$;
revoke all on function public.practice_claim(uuid,uuid), public.practice_budget(uuid), public.practice_tokens(uuid,bigint,bigint), public.practice_cycle(uuid),public.practice_save(uuid,uuid,text,bigint,boolean) from public,anon,authenticated;
grant execute on function public.practice_claim(uuid,uuid), public.practice_budget(uuid), public.practice_tokens(uuid,bigint,bigint), public.practice_cycle(uuid),public.practice_save(uuid,uuid,text,bigint,boolean) to service_role;
commit;
