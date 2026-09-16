begin;

alter table public.projects drop constraint projects_size_bytes_check;
alter table public.projects add constraint projects_size_bytes_check
  check (size_bytes > 0 and size_bytes <= 104857600);
alter table public.projects add column storage_parts integer not null default 0;
alter table public.projects add column upload_state text not null default 'ready'
  check (upload_state in ('uploading', 'ready'));
alter table public.projects add constraint projects_storage_parts_check check (
  storage_parts = 0 or storage_parts = (size_bytes + 8388607) / 8388608
);

-- Each private object stays below the Free plan's per-object limit.
-- Existing PDFs remain in their original bucket and format.
insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('pdf-parts', 'pdf-parts', false, 8388608, array['application/octet-stream']);

commit;
