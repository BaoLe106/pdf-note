"""Real browser + deployed API smoke test. Creates and removes its own PDF project.

Run with PDF_NOTE_PASSWORD set, after serving web/ on localhost:8000.
Development-only dependencies: pip install playwright pymupdf; playwright install chromium
"""
import json
import os
from pathlib import Path
import pymupdf as fitz
from playwright.sync_api import sync_playwright, expect
expect.set_options(timeout=45000)

OUT = Path('test-results')
OUT.mkdir(exist_ok=True)
BASE = os.environ.get('PDF_NOTE_TEST_URL', 'http://127.0.0.1:8000')
TITLE = 'Margin verification textbook'
NOTE = '繁體中文筆記：學而時習之。\nTiếng Việt: Học và ghi nhớ.\nEnglish: A thought worth keeping.'

def fixture():
    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((55, 80), 'Reading, with room for thought', fontsize=24)
    page.insert_text((55, 135), 'Learning is a journey. Keep the ideas that matter.', fontsize=15)
    page.insert_text((55, 195), '學而時習之，不亦說乎。繁體中文課本。', fontname='china-t', fontsize=20)
    page.insert_htmlbox(fitz.Rect(55, 230, 550, 320), '<p style="font-size:18px">Tiếng Việt: Đọc sách và ghi chú mỗi ngày.</p>')
    page = doc.new_page()
    page.insert_text((55, 90), 'Chapter two: Building understanding', fontsize=23)
    page.insert_text((55, 155), 'Every note is a conversation with a book.', fontsize=17)
    scan = fitz.open(); scanned = scan.new_page()
    scanned.insert_text((55, 100), 'A SCANNED PAGE', fontsize=30)
    scanned.insert_text((55, 175), 'Read slowly. Notice the details.', fontsize=23)
    scanned.insert_text((55, 235), 'Make a note. Remember the idea.', fontsize=23)
    scanned.insert_text((55, 300), '學習中文，每天閱讀。', fontname='china-t', fontsize=28)
    page = doc.new_page(); page.insert_image(page.rect, stream=scanned.get_pixmap(matrix=fitz.Matrix(2, 2)).tobytes('png'))
    path = OUT / (TITLE + '.pdf'); doc.save(path); doc.close(); scan.close(); return path

def select_chinese(page):
    page.evaluate("""() => {
      const spans = [...document.querySelectorAll('#text-layer span')];
      const span = spans.find(s => s.textContent.includes('學'));
      if (!span) throw Error('Chinese text is missing from the PDF text layer');
      if (span.getBoundingClientRect().width > document.getElementById('pdf-page').getBoundingClientRect().width * .7) throw Error('Chinese selection width does not match printed text');
      const range = document.createRange(); range.selectNodeContents(span);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    }""")
    expect(page.locator('#selection-popover')).to_be_visible()

def main():
    password = os.environ['PDF_NOTE_PASSWORD']
    pdf = fixture()
    with sync_playwright() as p:
        browser = p.chromium.launch()
        context = browser.new_context(viewport={'width': 1440, 'height': 1000}, permissions=['clipboard-read', 'clipboard-write'])
        page = context.new_page(); errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.set_default_timeout(45000)
        page.goto(BASE); page.locator('#password').fill(password); page.locator('#login-button').click()
        expect(page.locator('#app-view')).to_be_visible(); expect(page.locator('#upload-status')).to_have_text('')
        print('PASS: owner login', flush=True)
        # Clean only this test's previous project, if a prior run was interrupted.
        page.on('dialog', lambda dialog: dialog.accept())
        for _ in range(page.locator('.project-card').filter(has_text=TITLE).count()):
            page.locator('.project-card').filter(has_text=TITLE).first.locator('.project-delete').click()
            page.wait_for_timeout(1500)
        page.locator('#file-input').set_input_files(pdf)
        expect(page.locator('#reader-view')).to_be_visible()
        expect(page.locator('#text-layer span').first).to_be_visible()
        expect(page.locator('#reader-title')).to_have_text(TITLE)
        print('PASS: PDF upload, private download, and text rendering', flush=True)
        select_chinese(page)
        page.locator('#copy-selection').click()
        clipboard = page.evaluate('navigator.clipboard.readText()')
        assert '學' in clipboard
        page.locator('#close-selection').click(); expect(page.locator('#selection-popover')).to_be_hidden()
        select_chinese(page); page.locator('#note-selection').click()
        page.locator('#note-body').fill(NOTE); page.locator('#save-note').click()
        expect(page.locator('#note-dialog')).to_be_hidden(); expect(page.locator('.highlight-rect').first).to_be_visible()
        expect(page.locator('.note-card p')).to_have_text(NOTE)
        print('PASS: Chinese selection, Copy/Note/Close, and Unicode note saving', flush=True)
        page.locator('#zoom-in').click(); expect(page.locator('#zoom-fit')).to_have_text('120%')
        expect(page.locator('.highlight-rect').first).to_be_visible()
        page.locator('#next-page').click(); expect(page.locator('#page-input')).to_have_value('2')
        expect(page.locator('#save-status')).to_have_text('All changes saved')
        page.reload(); expect(page.locator('#upload-status')).to_have_text('')
        page.locator('.project-card').filter(has_text=TITLE).locator('.project-name').click()
        expect(page.locator('#page-input')).to_have_value('2'); expect(page.locator('#zoom-fit')).to_have_text('120%')
        expect(page.locator('.note-card p')).to_have_text(NOTE)
        page.locator('.note-card').get_by_text('Go to passage').click(); expect(page.locator('#page-input')).to_have_value('1')
        expect(page.locator('.highlight-rect').first).to_be_visible()
        print('PASS: page, zoom, highlights, and notes survive reopening', flush=True)
        page.locator('.note-card').get_by_text('Edit', exact=True).click(); page.locator('#note-body').fill(NOTE + '\n已修改 / Đã sửa / Edited')
        page.locator('#save-note').click(); expect(page.locator('#note-dialog')).to_be_hidden()
        expect(page.locator('.note-card p')).to_contain_text('已修改')
        with page.expect_download() as download:
            page.locator('#export-notes').click()
        content = Path(download.value.path()).read_text(encoding='utf-8-sig'); assert NOTE in content
        print('PASS: edit and UTF-8 Markdown export', flush=True)
        page.screenshot(path=str(OUT / 'reader-desktop.png'))
        page.set_viewport_size({'width': 402, 'height': 874})
        expect(page.locator('#mobile-notes')).to_be_visible(); expect(page.locator('#notes-panel')).to_be_hidden()
        page.locator('#mobile-notes').click(); expect(page.locator('#notes-panel')).to_be_visible()
        page.locator('#new-note').click(); page.locator('#note-body').fill('手機筆記 · Ghi chú trên điện thoại'); page.locator('#save-note').click()
        expect(page.locator('#note-dialog')).to_be_hidden(); expect(page.locator('.note-card')).to_have_count(2)
        page.screenshot(path=str(OUT / 'notes-mobile.png')); page.locator('#close-notes').click()
        page.wait_for_timeout(500); page.screenshot(path=str(OUT / 'reader-mobile.png'))
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Mobile page overflows viewport'
        print('PASS: mobile reader, notes drawer, and note creation', flush=True)
        if os.environ.get('PDF_NOTE_TEST_OCR') == '1':
            page.locator('#page-input').fill('3'); page.locator('#page-input').press('Tab')
            expect(page.locator('#reader-message')).to_contain_text('scanned page')
            page.locator('#ocr-button').click(); page.locator('#ocr-language').select_option('chi_tra+eng')
            page.locator('#ocr-form button.primary').click()
            expect(page.locator('#reader-message')).to_contain_text('Text recognized.', timeout=240000)
            assert page.locator('#text-layer').inner_text().strip()
            assert any(c in page.locator('#text-layer').inner_text() for c in ['學', '中', '文'])
            page.locator('#back-button').click(); expect(page.locator('#reader-view')).to_be_hidden()
            page.locator('.project-card').filter(has_text=TITLE).locator('.project-name').click()
            expect(page.locator('#text-layer')).to_have_class('ocr-layer')
            expect(page.locator('#text-layer span').first).to_be_visible()
            print('PASS: real on-device OCR and persistence', flush=True)
        page.locator('#back-button').click(); expect(page.locator('#reader-view')).to_be_hidden()
        page.evaluate("""() => {const key = Object.keys(localStorage).find(k => k.endsWith('-auth-token')); const s = JSON.parse(localStorage.getItem(key)); window.oldRefresh = s.refresh_token; s.expires_at = 1; localStorage.setItem(key, JSON.stringify(s));} """)
        old_refresh = page.evaluate('window.oldRefresh'); page.reload(); expect(page.locator('#app-view')).to_be_visible(); expect(page.locator('#upload-status')).to_have_text('')
        new_refresh = page.evaluate("JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => k.endsWith('-auth-token')))).refresh_token")
        assert new_refresh != old_refresh
        print('PASS: automatic access-token refresh and refresh-token rotation', flush=True)
        page.locator('.project-card').filter(has_text=TITLE).locator('.project-delete').click()
        expect(page.locator('.project-card').filter(has_text=TITLE)).to_have_count(0)
        page.locator('#logout-button').click(); expect(page.locator('#login-view')).to_be_visible()
        page.reload(); expect(page.locator('#login-view')).to_be_visible()
        page.screenshot(path=str(OUT / 'login-mobile.png'))
        print('PASS: project deletion and persistent logout', flush=True)
        assert not errors, errors
        browser.close()
        print('All browser checks passed; test PDF and notes removed.', flush=True)

if __name__ == '__main__':
    main()
