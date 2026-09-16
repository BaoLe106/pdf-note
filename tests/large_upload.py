"""Boundary and live multipart PDF checks; removes only its own test project.

PDF_NOTE_PASSWORD is required. PDF_NOTE_TEST_URL defaults to localhost:8000.
"""
import hashlib
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

expect.set_options(timeout=90000)
OUT = Path('test-results')
OUT.mkdir(exist_ok=True)
LIMIT = 100 * 1048576
TITLE = 'Large PDF boundary verification'
BASE = os.environ.get('PDF_NOTE_TEST_URL', 'http://127.0.0.1:8000')

def create_pdf(path, size):
    # An actual PDF with a page and an uncompressed, unreferenced stream.
    # This tests exact file sizes without committing large binary fixtures.
    def content(padding):
        objects = [b'<< /Type /Catalog /Pages 2 0 R >>',
                   b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
                   b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
                   b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
        text = b'BT /F1 24 Tf 55 740 Td (A 100 MB textbook) Tj ET'
        objects += [b'<< /Length %d >>\nstream\n' % len(text) + text + b'\nendstream',
                    b'<< /Length %d >>\nstream\n' % padding + b'\0' * padding + b'\nendstream']
        chunks = [b'%PDF-1.7\n']; offsets = [0]
        length = len(chunks[0])
        for index, obj in enumerate(objects, 1):
            offsets.append(length)
            chunk = f'{index} 0 obj\n'.encode() + obj + b'\nendobj\n'
            chunks.append(chunk); length += len(chunk)
        tail = f'xref\n0 {len(offsets)}\n0000000000 65535 f \n'.encode()
        tail += b''.join(f'{offset:010d} 00000 n \n'.encode() for offset in offsets[1:])
        tail += f'trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{length}\n%%EOF\n'.encode()
        return b''.join(chunks) + tail
    padding = size - 1000
    for _ in range(5):
        data = content(padding)
        if len(data) == size:
            path.write_bytes(data)
            return hashlib.sha256(data).hexdigest()
        padding += size - len(data)
    raise AssertionError('Could not construct exact-sized PDF')

def main():
    pdf = OUT / f'{TITLE}.pdf'
    digest = create_pdf(pdf, LIMIT)
    oversized = OUT / 'too-large.pdf'
    with oversized.open('wb') as file:
        file.write(b'%PDF-1.7\n'); file.truncate(LIMIT + 1)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={'width':1280, 'height':900})
        page.set_default_timeout(90000)
        page.goto(BASE)
        page.locator('#password').fill(os.environ['PDF_NOTE_PASSWORD'])
        page.locator('#login-button').click()
        expect(page.locator('#app-view')).to_be_visible()
        expect(page.locator('#upload-status')).to_have_text('')
        page.on('dialog', lambda d: d.accept())
        existing = page.locator('.project-card').filter(has_text=TITLE)
        while existing.count():
            existing.first.locator('.project-delete').click()
            page.wait_for_timeout(1500)
        requests = []
        page.on('request', lambda req: requests.append(req.url) if '/functions/v1/library' in req.url else None)
        page.locator('#file-input').set_input_files(oversized)
        expect(page.get_by_role('alertdialog')).to_be_visible()
        expect(page.locator('#upload-error-message')).to_contain_text('100 MB')
        assert not requests, 'Oversized file must be rejected before any API call'
        page.set_viewport_size({'width':402, 'height':874})
        page.screenshot(path=str(OUT / 'oversized-upload-mobile.png'))
        page.locator('#close-upload-error').click()
        expect(page.get_by_role('alertdialog')).to_be_hidden()
        print('PASS: 100 MB + 1 byte rejected locally with mobile-compatible error popup', flush=True)
        # Inject one temporary server failure to exercise safe chunk retries.
        failures = []
        def transient_failure(route):
            if not failures:
                failures.append(True)
                route.fulfill(status=503, content_type='application/json', body='{"error":"Temporary test failure"}')
            else:
                route.continue_()
        page.route('**/functions/v1/library?action=upload-part', transient_failure, times=1)
        page.on('response', lambda response: print(f'Upload part response: {response.status}', flush=True) if 'action=upload-part' in response.url else None)
        page.locator('#file-input').set_input_files(pdf)
        expect(page.locator('#upload-progress-wrap')).to_be_visible()
        expect(page.locator('#upload-progress')).to_have_attribute('max', '100')
        page.wait_for_function("Number(document.getElementById('upload-progress').value) > 0 && Number(document.getElementById('upload-progress').value) < 100", timeout=90000)
        page.screenshot(path=str(OUT / 'large-upload-progress-mobile.png'))
        page.wait_for_function("document.getElementById('reader-title').textContent === 'Large PDF boundary verification' || document.getElementById('upload-error-dialog').open", timeout=900000)
        assert not page.locator('#upload-error-dialog').evaluate('(dialog) => dialog.open'), page.locator('#upload-error-message').inner_text()
        expect(page.locator('#reader-title')).to_have_text(TITLE)
        expect(page.locator('#text-layer span').first).to_have_text('A 100 MB textbook', timeout=300000)
        assert failures
        print('PASS: exactly 100 MB uploaded in parts, retried, reassembled, and rendered', flush=True)
        # Verify the server's signed parts reproduce every byte of the PDF.
        result = page.evaluate('''async () => {
          const cfg = window.PDF_NOTE_CONFIG;
          const key = Object.keys(localStorage).find(k => k.endsWith('-auth-token'));
          const session = JSON.parse(localStorage.getItem(key));
          const call = async (action, body) => {
            const r = await fetch(cfg.supabaseUrl + '/functions/v1/library?action=' + action, {method:'POST', headers:{Authorization:'Bearer ' + session.access_token, apikey:cfg.supabaseAnonKey,'Content-Type':'application/json'},body:JSON.stringify(body)});
            return {status:r.status, data:await r.json()};
          };
          const listed = await call('projects', {});
          const project = listed.data.projects.find(p => p.title === 'Large PDF boundary verification');
          const opened = await call('open', {id:project.id});
          const output = new Uint8Array(project.size_bytes);
          for (let i=0;i<opened.data.parts.length;i++) output.set(new Uint8Array(await (await fetch(opened.data.parts[i])).arrayBuffer()),i*opened.data.part_bytes);
          const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256',output))].map(v=>v.toString(16).padStart(2,'0')).join('');
          const rejected = await call('begin-upload', {title:'Must not exist',size_bytes:104857601,page_count:1});
          return {hash, parts:opened.data.parts.length,rejected:rejected.status};
        }''')
        assert result['hash'] == digest and result['parts'] == 13
        assert result['rejected'] == 413
        print('PASS: signed downloads match SHA-256; API independently rejects over-limit size', flush=True)
        page.locator('#mobile-notes').click(); page.locator('#new-note').click()
        page.locator('#note-body').fill('大型課本 · Sách lớn · Large textbook')
        page.locator('#save-note').click(); expect(page.locator('#note-dialog')).to_be_hidden()
        page.locator('#close-notes').click(); page.locator('#back-button').click()
        expect(page.locator('#reader-view')).to_be_hidden()
        page.reload(); expect(page.locator('#upload-status')).to_have_text('')
        page.locator('.project-card').filter(has_text=TITLE).locator('.project-name').click()
        expect(page.locator('#text-layer span').first).to_have_text('A 100 MB textbook', timeout=300000)
        page.locator('#mobile-notes').click()
        expect(page.locator('.note-card p')).to_have_text('大型課本 · Sách lớn · Large textbook')
        page.locator('#close-notes').click(); page.locator('#back-button').click()
        expect(page.locator('#reader-view')).to_be_hidden()
        page.locator('.project-card').filter(has_text=TITLE).locator('.project-delete').click()
        expect(page.locator('.project-card').filter(has_text=TITLE)).to_have_count(0)
        print('PASS: large PDF and Unicode note reopen; test project deleted', flush=True)
        browser.close()

if __name__ == '__main__':
    main()
