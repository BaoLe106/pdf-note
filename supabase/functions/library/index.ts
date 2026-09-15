import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4';

const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
class HttpError extends Error { constructor(message: string, public status = 400) { super(message); } }
const requireId = (value: unknown) => { if (typeof value !== 'string' || !UUID.test(value)) throw new HttpError('Invalid identifier.'); return value; };
function check(result: { error: any }) { if (result.error) throw new Error(result.error.message); }
function rectangle(value: any) {
  return value && ['x', 'y', 'w', 'h'].every(k => typeof value[k] === 'number' && Number.isFinite(value[k]) && value[k] >= 0 && value[k] <= 1)
    && value.w > 0 && value.h > 0 && value.x + value.w <= 1.025 && value.y + value.h <= 1.025;
}
async function ownedProject(id: unknown, owner: string) {
  const result = await supabase.from('projects').select('*').eq('id', requireId(id)).eq('owner_id', owner).maybeSingle();
  check(result); if (!result.data) throw new HttpError('Document not found.', 404); return result.data;
}
function validPage(page: unknown, count: number) { if (!Number.isInteger(page) || Number(page) < 1 || Number(page) > count) throw new HttpError('Invalid page number.'); return Number(page); }
async function allRows(table: string, column: string, id: string) {
  const rows: any[] = [];
  for (let start = 0; ; start += 1000) {
    const result = await supabase.from(table).select('*').eq(column, id).order(table === 'notes' ? 'created_at' : table === 'projects' ? 'updated_at' : 'page', { ascending: false }).range(start, start + 999);
    check(result); rows.push(...(result.data || [])); if ((result.data || []).length < 1000) return rows;
  }
}

Deno.serve(async req => {
  const origin = req.headers.get('origin') || '';
  const allowed = (Deno.env.get('ALLOWED_ORIGINS') || 'https://baole106.github.io,http://localhost:8000,http://127.0.0.1:8000').split(',');
  const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Vary': 'Origin', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
  if (allowed.includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
  if (origin && !allowed.includes(origin)) return json({ error: 'Origin not allowed.' }, 403);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  try {
    const authorization = req.headers.get('authorization') || '';
    if (!authorization.startsWith('Bearer ')) throw new HttpError('Sign in to continue.', 401);
    const { data: { user }, error } = await supabase.auth.getUser(authorization.slice(7));
    if (error || !user) throw new HttpError('Your session has expired. Please sign in.', 401);
    const owner = await supabase.from('app_owner').select('user_id').eq('user_id', user.id).maybeSingle();
    check(owner); if (!owner.data) throw new HttpError('This library is private.', 403);
    const action = new URL(req.url).searchParams.get('action');
    if (action === 'upload') {
      if (Number(req.headers.get('content-length')) > 41 * 1048576) throw new HttpError('Choose a PDF smaller than 40 MB.', 413);
      const form = await req.formData(), file = form.get('file');
      if (!(file instanceof File) || !file.size || file.size > 40 * 1048576) throw new HttpError('Choose a PDF smaller than 40 MB.');
      const prefix = await file.slice(0, 1024).text(); if (!prefix.includes('%PDF-')) throw new HttpError('This file is not a PDF.');
      const pageCount = Number(form.get('page_count')); if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > 100000) throw new HttpError('Invalid PDF page count.');
      const id = crypto.randomUUID(), path = `${user.id}/${id}.pdf`;
      const title = file.name.replace(/\.pdf$/i, '').trim().slice(0, 250) || 'Untitled document';
      const upload = await supabase.storage.from('pdfs').upload(path, file, { contentType: 'application/pdf', upsert: false }); check(upload);
      const result = await supabase.from('projects').insert({ id, owner_id: user.id, storage_path: path, title, size_bytes: file.size, page_count: pageCount }).select().single();
      if (result.error) { await supabase.storage.from('pdfs').remove([path]); if (result.error.message.includes('Library storage')) throw new HttpError(result.error.message, 409); check(result); }
      return json({ project: result.data }, 201);
    }
    const raw = await req.text(); if (raw.length > 2_000_000) throw new HttpError('Request is too large.', 413);
    let body: any; try { body = JSON.parse(raw || '{}'); } catch { throw new HttpError('Invalid JSON.'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError('Invalid request.');
    if (action === 'projects') return json({ projects: await allRows('projects', 'owner_id', user.id) });
    if (action === 'open') {
      const project = await ownedProject(body.id, user.id);
      const [signed, notes, ocr] = await Promise.all([supabase.storage.from('pdfs').createSignedUrl(project.storage_path, 3600), allRows('notes', 'project_id', project.id), allRows('ocr_pages', 'project_id', project.id)]);
      check(signed); return json({ url: signed.data!.signedUrl, notes, ocr });
    }
    if (action === 'position') {
      const project = await ownedProject(body.id, user.id); const page = validPage(body.page, project.page_count);
      if (typeof body.zoom !== 'number' || !Number.isFinite(body.zoom) || body.zoom < .6 || body.zoom > 2.5) throw new HttpError('Invalid zoom.');
      check(await supabase.from('projects').update({ current_page: page, zoom: body.zoom, updated_at: new Date().toISOString() }).eq('id', project.id).eq('owner_id', user.id)); return json({ ok: true });
    }
    if (action === 'delete-project') {
      const project = await ownedProject(body.id, user.id);
      check(await supabase.storage.from('pdfs').remove([project.storage_path]));
      check(await supabase.from('projects').delete().eq('id', project.id).eq('owner_id', user.id)); return json({ ok: true });
    }
    if (action === 'save-note') {
      const project = await ownedProject(body.project_id, user.id), page = validPage(body.page, project.page_count);
      if (typeof body.quote !== 'string' || body.quote.length > 20000 || typeof body.body !== 'string' || body.body.length > 50000 || !(body.quote.trim() || body.body.trim())) throw new HttpError('Write a note or select a passage, within the length limit.');
      if (!['sage', 'yellow', 'rose', 'blue'].includes(body.color) || !Array.isArray(body.rects) || body.rects.length > 1000 || !body.rects.every(rectangle)) throw new HttpError('Invalid highlight.');
      const note = { page, quote: body.quote, body: body.body, rects: body.rects.map(({ x, y, w, h }: any) => ({ x, y, w, h })), color: body.color, updated_at: new Date().toISOString() };
      const result = body.id
        ? await supabase.from('notes').update(note).eq('id', requireId(body.id)).eq('project_id', project.id).select().maybeSingle()
        : await supabase.from('notes').insert({ ...note, project_id: project.id }).select().single();
      check(result); if (!result.data) throw new HttpError('Note not found.', 404); return json({ note: result.data });
    }
    if (action === 'delete-note') {
      const project = await ownedProject(body.project_id, user.id);
      check(await supabase.from('notes').delete().eq('id', requireId(body.id)).eq('project_id', project.id)); return json({ ok: true });
    }
    if (action === 'save-ocr') {
      const project = await ownedProject(body.project_id, user.id), page = validPage(body.page, project.page_count);
      if (!Array.isArray(body.words) || body.words.length > 10000 || !body.words.every((w: any) => rectangle(w) && typeof w.text === 'string' && w.text.length < 500)) throw new HttpError('Invalid recognized text.');
      const words = body.words.map(({ x, y, w, h, text }: any) => ({ x, y, w, h, text }));
      check(await supabase.from('ocr_pages').upsert({ project_id: project.id, page, words })); return json({ ok: true });
    }
    throw new HttpError('Unknown action.', 404);
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message }, error.status);
    console.error('Library operation failed:', error instanceof Error ? error.message : 'Unknown error');
    return json({ error: 'Could not complete this action. Please try again.' }, 500);
  }
});
