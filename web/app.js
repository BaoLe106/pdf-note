import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.57.4/+esm';
import * as pdfjs from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.mjs';
pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.mjs';
const $ = id => document.getElementById(id);
const config = window.PDF_NOTE_CONFIG;
const client = config.supabaseUrl && config.supabaseAnonKey ? createClient(config.supabaseUrl, config.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } }) : null;
const state = { projects: [], project: null, pdf: null, notes: [], page: 1, zoom: 1, selection: null, editing: null, ocr: {}, render: 0, busy: false, loading: false, session: null };
let renderTask, textTask, saveTimer, selectionTimer, toastTimer, resizeTimer, documentGeneration = 0;
let positionQueue = Promise.resolve();
const formatSize = n => `${(n / 1048576).toFixed(1)} MB`;
const date = value => new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 4500); }
function message(error) { return error?.message || 'Something went wrong. Please try again.'; }
async function api(action, body = {}) {
  if (!client) throw new Error('The library is being set up. Please try again after deployment.');
  const { data: { session } } = await client.auth.getSession();
  if (!session) throw new Error('Please sign in again.');
  const isFile = body instanceof FormData;
  const invoke = async token => fetch(`${config.supabaseUrl}/functions/v1/library?action=${encodeURIComponent(action)}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, apikey: config.supabaseAnonKey, ...(isFile ? {} : { 'Content-Type': 'application/json' }) }, body: isFile ? body : JSON.stringify(body)
  });
  let response = await invoke(session.access_token);
  if (response.status === 401) {
    const { data, error } = await client.auth.refreshSession();
    if (error || !data.session) throw new Error('Your session expired. Please sign in again.');
    response = await invoke(data.session.access_token);
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status}). Please try again.`);
  return result;
}
function displaySession(session) {
  state.session = session;
  $('login-view').hidden = !!session; $('app-view').hidden = !session;
  if (!session) { closeReader(); state.projects = []; renderProjects(); }
}
$('login-form').addEventListener('submit', async event => {
  event.preventDefault(); $('login-error').textContent = ''; $('login-button').disabled = true;
  try {
    if (!client) throw new Error('The library is being set up. Connection settings are not available yet.');
    if ($('username').value.trim().toLowerCase() !== 'baole106') throw new Error('Incorrect username or password.');
    const { data, error } = await client.auth.signInWithPassword({ email: config.loginEmail, password: $('password').value });
    if (error) throw new Error('Incorrect username or password.');
    $('password').value = ''; displaySession(data.session); await loadProjects();
  } catch (error) { $('login-error').textContent = message(error); } finally { $('login-button').disabled = false; }
});
$('logout-button').onclick = async () => {
  try { await flushPosition(); const { error } = await client.auth.signOut(); if (error) throw error; displaySession(null); } catch (error) { toast(message(error)); }
};
async function loadProjects() {
  $('upload-status').textContent = 'Opening your library…';
  try { const result = await api('projects'); state.projects = result.projects; renderProjects(); $('upload-status').textContent = ''; }
  catch (error) { $('upload-status').textContent = message(error); }
}
function renderProjects() {
  const query = $('project-search').value.toLocaleLowerCase();
  const projects = state.projects.filter(p => p.title.toLocaleLowerCase().includes(query));
  $('project-grid').replaceChildren();
  $('library-count').textContent = $('document-count').textContent = state.projects.length;
  $('library-empty').hidden = state.projects.length > 0;
  const bytes = state.projects.reduce((sum, p) => sum + p.size_bytes, 0);
  $('storage-value').textContent = formatSize(bytes); $('storage-progress').value = bytes / 1048576;
  for (const project of projects) {
    const card = document.createElement('article'); card.className = 'project-card';
    card.innerHTML = '<button class="project-cover" aria-label="Open document"><span class="book-title"></span></button><div class="project-info"><button class="project-name"></button><div class="project-meta"><span class="pages"></span><span>·</span><span class="size"></span></div><div class="project-foot"><span class="last-read"></span><button class="project-delete" aria-label="Delete project" title="Delete project">×</button></div></div>';
    card.querySelector('.book-title').textContent = project.title;
    card.querySelector('.project-name').textContent = project.title;
    card.querySelector('.pages').textContent = `${project.page_count} pages`;
    card.querySelector('.size').textContent = formatSize(project.size_bytes);
    card.querySelector('.last-read').textContent = `Page ${project.current_page} · ${date(project.updated_at)}`;
    card.querySelector('.project-cover').onclick = card.querySelector('.project-name').onclick = () => openProject(project).catch(e => toast(message(e)));
    card.querySelector('.project-delete').onclick = async () => {
      if (!confirm(`Delete “${project.title}” and all its notes? This cannot be undone.`)) return;
      try { await api('delete-project', { id: project.id }); await loadProjects(); } catch (error) { toast(message(error)); }
    };
    $('project-grid').append(card);
  }
  if (!projects.length && state.projects.length) { const p = document.createElement('p'); p.textContent = 'No documents match your search.'; $('project-grid').append(p); }
}
$('project-search').oninput = renderProjects;
for (const id of ['upload-button', 'empty-upload']) $(id).onclick = () => $('file-input').click();
$('file-input').onchange = async () => {
  const file = $('file-input').files[0]; $('file-input').value = ''; if (!file) return;
  $('upload-button').disabled = $('empty-upload').disabled = true;
  $('upload-status').textContent = 'Checking your PDF…'; let preview;
  try {
    if (file.size > 40 * 1048576) throw new Error('Please choose a PDF smaller than 40 MB.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!new TextDecoder().decode(bytes.slice(0, 1024)).includes('%PDF-')) throw new Error('This file is not a PDF.');
    preview = await pdfjs.getDocument({ data: bytes }).promise;
    const form = new FormData(); form.append('file', file); form.append('page_count', String(preview.numPages));
    await preview.destroy(); preview = null;
    $('upload-status').textContent = 'Uploading your textbook. Keep this page open…';
    const { project } = await api('upload', form);
    await loadProjects(); await openProject(project); toast('Your book has a home.');
  } catch (error) { $('upload-status').textContent = error.name === 'PasswordException' ? 'Please remove the PDF password before importing it.' : message(error); }
  finally { preview?.destroy(); $('upload-button').disabled = $('empty-upload').disabled = false; }
};
async function openProject(project) {
  if (state.loading) return; state.loading = true; const generation = ++documentGeneration;
  $('reader-view').hidden = false; $('reader-title').textContent = project.title; $('reader-message').textContent = 'Opening your textbook…';
  $('pdf-page').hidden = true; $('notes-list').replaceChildren(); $('notes-empty').hidden = false;
  try {
    const { url, notes, ocr } = await api('open', { id: project.id });
    const loading = pdfjs.getDocument({ url, cMapUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/cmaps/', cMapPacked: true, standardFontDataUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/standard_fonts/' });
    const pdf = await loading.promise;
    if (generation !== documentGeneration) { await pdf.destroy(); return; }
    state.project = project; state.pdf = pdf; state.notes = notes; state.ocr = Object.fromEntries(ocr.map(p => [p.page, p.words]));
    $('save-status').textContent = 'All changes saved';
    state.page = Math.min(project.current_page, pdf.numPages); state.zoom = project.zoom || 1; $('note-search').value = '';
    renderNotes(); await renderPage();
  } catch (error) { if (generation === documentGeneration) $('reader-message').textContent = message(error); }
  finally { state.loading = false; }
}
function closeReader() {
  ++documentGeneration; ++state.render; clearTimeout(saveTimer); hideSelection();
  renderTask?.cancel(); textTask?.cancel(); state.pdf?.destroy(); state.pdf = null; state.project = null; state.notes = []; state.ocr = {};
  $('reader-view').hidden = true; $('notes-panel').classList.remove('open'); $('note-dialog').close(); $('ocr-dialog').close();
}
$('back-button').onclick = async () => { if (state.busy) return toast('Please wait for text recognition to finish.'); try { await flushPosition(); closeReader(); await loadProjects(); } catch (e) { toast(message(e)); } };
$('library-button').onclick = () => $('back-button').click();
async function renderPage() {
  if (!state.pdf) return;
  const sequence = ++state.render; hideSelection();
  renderTask?.cancel(); textTask?.cancel();
  const previous = renderTask; if (previous) await previous.promise.catch(() => {});
  const page = await state.pdf.getPage(state.page); if (sequence !== state.render) return;
  const base = page.getViewport({ scale: 1 });
  const available = Math.max(200, $('pdf-scroll').clientWidth - (innerWidth <= 760 ? 20 : 56));
  const scale = Math.min(available / base.width, 1.5) * state.zoom;
  const viewport = page.getViewport({ scale });
  const ratio = Math.min(devicePixelRatio || 1, 2, Math.sqrt(8000000 / (viewport.width * viewport.height)));
  const canvas = $('pdf-canvas'); canvas.width = Math.floor(viewport.width * ratio); canvas.height = Math.floor(viewport.height * ratio);
  canvas.style.width = `${viewport.width}px`; canvas.style.height = `${viewport.height}px`;
  const container = $('pdf-page'); container.hidden = false; container.style.width = `${viewport.width}px`; container.style.height = `${viewport.height}px`; container.style.setProperty('--scale-factor', scale);
  $('text-layer').replaceChildren(); $('text-layer').className = 'textLayer'; $('highlight-layer').replaceChildren();
  $('reader-message').textContent = ''; $('page-input').value = state.page; $('page-input').max = state.pdf.numPages; $('page-total').textContent = `/ ${state.pdf.numPages}`; $('page-label').textContent = `PAGE ${state.page}`;
  $('zoom-fit').textContent = state.zoom === 1 ? 'Fit' : `${Math.round(state.zoom * 100)}%`;
  $('prev-page').disabled = state.page <= 1; $('next-page').disabled = state.page >= state.pdf.numPages;
  renderTask = page.render({ canvasContext: canvas.getContext('2d'), viewport, transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0] });
  try { await renderTask.promise; if (sequence !== state.render) return;
    if (state.ocr[state.page]) renderOCR(state.ocr[state.page]);
    else {
      const content = await page.getTextContent(); if (sequence !== state.render) return;
      textTask = new pdfjs.TextLayer({ textContentSource: content, container: $('text-layer'), viewport }); await textTask.render();
      // PDF.js can retain a stale measuring font on the first 30px text run.
      // Re-layout after its ascent cache is warm, then restore the exact viewport.
      // https://github.com/mozilla/pdf.js/issues/21578
      textTask.update({ viewport: page.getViewport({ scale: scale * 1.000001 }) });
      textTask.update({ viewport });
      if (!content.items.some(i => i.str?.trim())) $('reader-message').textContent = 'This looks like a scanned page. Use “Recognize text” to select passages.';
    }
    renderHighlights();
  } catch (error) { if (error.name !== 'RenderingCancelledException' && sequence === state.render) $('reader-message').textContent = message(error); }
}
async function changePage(value) {
  if (!state.pdf || state.busy) return;
  state.page = Math.max(1, Math.min(state.pdf.numPages, Math.trunc(Number(value)) || 1)); $('pdf-scroll').scrollTo(0, 0);
  schedulePosition(); await renderPage();
}
$('prev-page').onclick = () => changePage(state.page - 1); $('next-page').onclick = () => changePage(state.page + 1); $('page-input').onchange = () => changePage($('page-input').value);
async function zoom(value) { if (state.busy || !state.pdf) return; state.zoom = Math.max(.6, Math.min(2.5, value)); schedulePosition(); await renderPage(); }
$('zoom-in').onclick = () => zoom(state.zoom + .2); $('zoom-out').onclick = () => zoom(state.zoom - .2); $('zoom-fit').onclick = () => zoom(1);
function schedulePosition() { clearTimeout(saveTimer); $('save-status').textContent = 'Saving position…'; saveTimer = setTimeout(() => flushPosition().catch(e => toast(message(e))), 700); }
function flushPosition() {
  clearTimeout(saveTimer); if (!state.project) return Promise.resolve();
  const project = state.project; const page = state.page, zoom = state.zoom;
  const isCurrent = () => state.project === project && state.page === page && state.zoom === zoom;
  const save = async () => {
    try {
      if (project.current_page !== page || project.zoom !== zoom) {
        await api('position', { id: project.id, page, zoom }); project.current_page = page; project.zoom = zoom;
      }
      if (isCurrent()) $('save-status').textContent = 'All changes saved';
    } catch (e) { if (isCurrent()) $('save-status').textContent = 'Position not saved · retry by changing page'; throw e; }
  };
  positionQueue = positionQueue.catch(() => {}).then(save);
  return positionQueue;
}
document.addEventListener('visibilitychange', () => { if (document.hidden) flushPosition().catch(() => {}); });
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (state.pdf && !state.busy) renderPage().catch(e => toast(message(e))); }, 220); });
function hideSelection() { $('selection-popover').hidden = true; state.selection = null; }
function captureSelection() {
  if (!state.project || $('note-dialog').open || state.busy) return;
  const selection = window.getSelection(); const layer = $('text-layer');
  if (!selection.rangeCount || selection.isCollapsed || !layer.contains(selection.anchorNode) || !layer.contains(selection.focusNode)) return hideSelection();
  const range = selection.getRangeAt(0); const text = selection.toString().trim(); if (!text) return hideSelection();
  const box = $('pdf-page').getBoundingClientRect();
  const rects = Array.from(range.getClientRects()).map(r => ({
    left: Math.max(box.left, r.left), top: Math.max(box.top, r.top), right: Math.min(box.right, r.right), bottom: Math.min(box.bottom, r.bottom)
  })).filter(r => r.right - r.left > 1 && r.bottom - r.top > 1).map(r => ({ x: (r.left - box.left) / box.width, y: (r.top - box.top) / box.height, w: (r.right - r.left) / box.width, h: (r.bottom - r.top) / box.height }));
  if (!rects.length) return;
  state.selection = { quote: text.slice(0, 20000), rects: rects.slice(0, 1000), page: state.page };
  const popup = $('selection-popover'); popup.hidden = false;
  const bounds = range.getBoundingClientRect(); const visual = window.visualViewport;
  const maxY = (visual?.height || innerHeight) + (visual?.offsetTop || 0);
  popup.style.left = `${Math.max(8, Math.min(innerWidth - popup.offsetWidth - 8, bounds.left + bounds.width / 2 - popup.offsetWidth / 2))}px`;
  popup.style.top = `${Math.max(65, Math.min(maxY - popup.offsetHeight - 12, bounds.top - popup.offsetHeight - 9))}px`;
}
document.addEventListener('selectionchange', () => { clearTimeout(selectionTimer); selectionTimer = setTimeout(captureSelection, 240); });
$('text-layer').addEventListener('pointerup', () => { clearTimeout(selectionTimer); selectionTimer = setTimeout(captureSelection, 60); });
$('pdf-scroll').addEventListener('scroll', hideSelection, { passive: true });
$('selection-popover').addEventListener('pointerdown', e => e.preventDefault());
$('selection-popover').addEventListener('pointerup', e => {
  // WebKit suppresses the synthetic click after a cancelled touch pointerdown.
  // Act on pointerup so the selection stays intact and touch actions still work.
  if (e.pointerType !== 'mouse') { e.preventDefault(); e.target.closest('button')?.click(); }
});
$('close-selection').onclick = () => { window.getSelection().removeAllRanges(); hideSelection(); };
$('copy-selection').onclick = async () => { if (!state.selection) return; try { await navigator.clipboard.writeText(state.selection.quote); toast('Passage copied'); } catch { toast('Use your browser’s Copy action to copy this passage.'); } };
$('note-selection').onclick = () => { if (state.selection) editNote(null, state.selection); };
function renderHighlights() {
  $('highlight-layer').replaceChildren();
  for (const note of state.notes.filter(n => n.page === state.page)) for (const rect of note.rects) {
    const el = document.createElement('div'); el.className = `highlight-rect ${note.color}`;
    Object.assign(el.style, { left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` }); $('highlight-layer').append(el);
  }
}
function renderNotes() {
  $('notes-list').replaceChildren(); $('note-count').textContent = $('notes-total').textContent = state.notes.length;
  $('notes-list').hidden = state.notes.length === 0;
  const query = $('note-search').value.toLocaleLowerCase(); const notes = state.notes.filter(n => `${n.quote}\n${n.body}`.toLocaleLowerCase().includes(query));
  $('notes-empty').hidden = state.notes.length > 0;
  for (const note of notes) {
    const card = document.createElement('article'); card.className = 'note-card';
    const header = document.createElement('div'); header.className = 'note-card-header'; header.textContent = `PAGE ${note.page} · ${date(note.created_at)}`; card.append(header);
    if (note.quote) { const quote = document.createElement('blockquote'); quote.textContent = note.quote; quote.style.borderColor = `var(--${note.color})`; card.append(quote); }
    if (note.body) { const body = document.createElement('p'); body.textContent = note.body; card.append(body); }
    const actions = document.createElement('div'); actions.className = 'note-card-actions';
    const jump = document.createElement('button'); jump.textContent = 'Go to passage ↗'; jump.onclick = async () => { $('notes-panel').classList.remove('open'); await changePage(note.page); if (note.rects[0]) $('pdf-scroll').scrollTop = Math.max(0, note.rects[0].y * $('pdf-page').offsetHeight - 100); };
    const edit = document.createElement('button'); edit.textContent = 'Edit'; edit.onclick = () => editNote(note); actions.append(jump, edit); card.append(actions); $('notes-list').append(card);
  }
  if (query && !notes.length) { const p = document.createElement('p'); p.className = 'small'; p.textContent = 'No notes match your search.'; $('notes-list').append(p); }
}
$('note-search').oninput = renderNotes;
function editNote(note = null, selection = null) {
  if (!state.project) return; state.editing = note ? { ...note } : { page: selection?.page || state.page, rects: selection?.rects || [], quote: selection?.quote || '', body: '', color: 'sage' };
  $('note-quote').value = state.editing.quote; $('note-body').value = state.editing.body; $('note-page-label').textContent = `PAGE ${state.editing.page}`;
  $('quote-label').hidden = $('note-quote').hidden = !state.editing.quote && !state.editing.rects.length;
  document.querySelector(`input[name="color"][value="${state.editing.color}"]`).checked = true;
  $('delete-note').hidden = !note; $('note-error').textContent = ''; hideSelection(); $('note-dialog').showModal(); $('note-body').focus();
}
$('new-note').onclick = () => editNote(); $('cancel-note').onclick = () => $('note-dialog').close();
$('note-form').onsubmit = async event => {
  event.preventDefault(); $('note-error').textContent = ''; $('save-note').disabled = true;
  try {
    const note = { ...state.editing, quote: $('note-quote').value.trim(), body: $('note-body').value.trim(), color: document.querySelector('input[name="color"]:checked').value };
    if (!note.quote && !note.body) throw new Error('Write a note or keep a selected passage.');
    const { note: saved } = await api('save-note', { project_id: state.project.id, id: note.id, page: note.page, quote: note.quote, body: note.body, rects: note.rects, color: note.color });
    state.notes = [saved, ...state.notes.filter(n => n.id !== saved.id)]; renderNotes(); renderHighlights(); $('note-dialog').close(); window.getSelection().removeAllRanges(); toast('Note saved');
  } catch (error) { $('note-error').textContent = message(error); } finally { $('save-note').disabled = false; }
};
$('delete-note').onclick = async () => {
  if (!confirm('Delete this note and its highlight?')) return;
  $('delete-note').disabled = true;
  try { await api('delete-note', { id: state.editing.id, project_id: state.project.id }); state.notes = state.notes.filter(n => n.id !== state.editing.id); renderNotes(); renderHighlights(); $('note-dialog').close(); toast('Note deleted'); }
  catch (e) { $('note-error').textContent = message(e); } finally { $('delete-note').disabled = false; }
};
$('mobile-notes').onclick = () => $('notes-panel').classList.toggle('open'); $('close-notes').onclick = () => $('notes-panel').classList.remove('open');
$('export-notes').onclick = () => {
  if (!state.project) return;
  const content = `# ${state.project.title}\n\n` + [...state.notes].sort((a, b) => a.page - b.page).map(n => `## Page ${n.page}\n\n${n.quote ? n.quote.split('\n').map(l => `> ${l}`).join('\n') + '\n\n' : ''}${n.body}\n`).join('\n---\n\n');
  const url = URL.createObjectURL(new Blob(['\ufeff', content], { type: 'text/markdown;charset=utf-8' })); const a = document.createElement('a'); a.href = url; a.download = `${state.project.title.replace(/[<>:"/\\|?*]/g, '_')}-notes.md`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
$('ocr-button').onclick = () => { if (state.pdf && !state.busy) $('ocr-dialog').showModal(); }; $('cancel-ocr').onclick = () => $('ocr-dialog').close();
async function loadTesseract() {
  if (window.Tesseract) return window.Tesseract;
  await new Promise((resolve, reject) => { const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/tesseract.min.js'; s.onload = resolve; s.onerror = () => reject(new Error('Could not load text recognition. Check your connection.')); document.head.append(s); }); return window.Tesseract;
}
$('ocr-form').onsubmit = async event => {
  event.preventDefault(); $('ocr-dialog').close(); state.busy = true; $('ocr-button').disabled = true; let worker;
  const project = state.project, pageNumber = state.page;
  try {
    $('reader-message').textContent = 'Loading recognition language. The first run may take a minute…';
    const Tesseract = await loadTesseract();
    worker = await Tesseract.createWorker($('ocr-language').value, 1, { logger: m => { if (m.status) $('reader-message').textContent = `${m.status} ${Math.round((m.progress || 0) * 100)}%`; } });
    const page = await state.pdf.getPage(pageNumber), base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(2.5, 2000 / Math.max(base.width, base.height)) });
    const canvas = document.createElement('canvas'); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    await worker.setParameters({ tessedit_pageseg_mode: $('ocr-language').value.includes('_vert') ? '5' : '3' });
    const { data } = await worker.recognize(canvas, {}, { tsv: true, text: true });
    const words = (data.tsv || '').split('\n').slice(1).map(line => line.split('\t')).filter(v => v[0] === '5' && v[11]?.trim()).map(v => ({ text: v.slice(11).join('\t'), x: Number(v[6]) / canvas.width, y: Number(v[7]) / canvas.height, w: Number(v[8]) / canvas.width, h: Number(v[9]) / canvas.height }));
    if (!words.length) throw new Error('No text was recognized. Try a different language or a clearer scan.');
    await api('save-ocr', { project_id: project.id, page: pageNumber, words }); state.ocr[pageNumber] = words; renderOCR(words);
    $('reader-message').textContent = 'Text recognized. Select a passage; you can correct recognition mistakes in your note.';
  } catch (error) { $('reader-message').textContent = message(error); }
  finally { await worker?.terminate(); state.busy = false; $('ocr-button').disabled = false; }
};
function renderOCR(words) {
  const layer = $('text-layer'); layer.replaceChildren(); layer.className = 'ocr-layer';
  const width = $('pdf-page').offsetWidth, height = $('pdf-page').offsetHeight;
  for (const word of words) { const span = document.createElement('span'); span.textContent = word.text + ' '; Object.assign(span.style, { left: `${word.x * 100}%`, top: `${word.y * 100}%`, fontSize: `${word.h * height}px`, height: `${word.h * height}px` }); layer.append(span); const measured = span.getBoundingClientRect().width; if (measured) span.style.transform = `scaleX(${word.w * width / measured})`; }
}
document.addEventListener('keydown', event => { if (event.key === 'Escape') { hideSelection(); $('notes-panel').classList.remove('open'); } if (!state.pdf || /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) || document.querySelector('dialog[open]')) return; if (event.key === 'ArrowRight') changePage(state.page + 1); if (event.key === 'ArrowLeft') changePage(state.page - 1); });
if (client) {
  client.auth.onAuthStateChange((event, session) => { if (event === 'SIGNED_OUT') displaySession(null); else state.session = session; });
  const { data: { session } } = await client.auth.getSession(); displaySession(session); if (session) await loadProjects();
}
