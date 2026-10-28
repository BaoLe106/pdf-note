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
TEXTBOX = 'Floating thought · 浮動文字框 · Ghi chú nổi'

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
        assert '#/pdf/' in page.url; pdf_url = page.url; pdf_id = pdf_url.rsplit('/', 1)[-1]
        anonymous = browser.new_context(viewport={'width': 1000, 'height': 700}); anonymous_page = anonymous.new_page(); open_requests = []
        anonymous_page.on('request', lambda request: open_requests.append(request.url) if 'action=open' in request.url else None)
        anonymous_page.goto(pdf_url); expect(anonymous_page.locator('#login-view')).to_be_visible(); expect(anonymous_page.locator('#reader-view')).to_be_hidden()
        anonymous_status = anonymous_page.evaluate("""async id => { const c = window.PDF_NOTE_CONFIG; return (await fetch(`${c.supabaseUrl}/functions/v1/library?action=open`, {method: 'POST', headers: {apikey: c.supabaseAnonKey, 'Content-Type': 'application/json'}, body: JSON.stringify({id})})).status }""", pdf_id)
        assert anonymous_status == 401 and len(open_requests) == 1
        anonymous.close()
        print('PASS: UUID document route, server-side anonymous denial, private download, and text rendering', flush=True)
        select_chinese(page)
        page.locator('#copy-selection').click()
        clipboard = page.evaluate('navigator.clipboard.readText()')
        assert '學' in clipboard
        page.locator('#close-selection').click(); expect(page.locator('#selection-popover')).to_be_hidden()
        select_chinese(page); page.locator('#note-selection').click()
        page.locator('#note-body').fill(NOTE); page.locator('#save-note').click()
        expect(page.locator('#note-dialog')).to_be_hidden(); expect(page.locator('.highlight-rect').first).to_be_visible()
        expect(page.locator('.note-card p')).to_have_text(NOTE)
        page.locator('.note-hit-target').first.hover(); expect(page.locator('#note-popover')).to_be_visible()
        assert page.locator('#note-popover-quote').evaluate("el => getComputedStyle(el).fontSize") == '16.5px'
        assert page.locator('#note-popover-body').evaluate("el => getComputedStyle(el).fontSize") == '18px'
        page.locator('#close-note-popover').click()
        print('PASS: Chinese selection, Copy/Note/Close, and Unicode note saving', flush=True)
        select_chinese(page); page.locator('#textbox-selection').click()
        box = page.locator('.floating-textbox').first; expect(box).to_be_visible()
        editor = box.locator('.textbox-editor'); editor.fill(TEXTBOX)
        box.locator('.textbox-size').select_option('20'); box.locator('.textbox-color').select_option('#b64b4b')
        before = box.bounding_box(); handle = box.locator('.textbox-handle').bounding_box()
        page.mouse.move(handle['x'] + handle['width'] / 2, handle['y'] + handle['height'] / 2)
        page.mouse.down(); page.mouse.move(handle['x'] + handle['width'] / 2 + 35, handle['y'] + handle['height'] / 2 + 25); page.mouse.up()
        after_drag = box.bounding_box(); assert after_drag['x'] != before['x'] or after_drag['y'] != before['y']
        assert abs(after_drag['width'] - before['width']) < 2 and abs(after_drag['height'] - before['height']) < 2
        resize = box.locator('.textbox-resize').bounding_box(); page.mouse.move(resize['x'] + resize['width'] / 2, resize['y'] + resize['height'] / 2)
        page.mouse.down(); page.mouse.move(resize['x'] + resize['width'] / 2 + 28, resize['y'] + resize['height'] / 2 + 18); page.mouse.up()
        after_resize = box.bounding_box(); assert after_resize['width'] > after_drag['width'] or after_resize['height'] > after_drag['height']
        page.locator('#page-label').click(); expect(page.locator('#save-status')).to_have_text('All changes saved')
        assert box.evaluate("el => { const style = getComputedStyle(el); return style.borderStyle === 'solid' && style.borderWidth === '1px' && style.backgroundColor === 'rgba(0, 0, 0, 0)' }")
        expect(page.locator('.note-card').filter(has_text=TEXTBOX)).to_be_visible()
        print('PASS: floating text box creation, editing, styling, dragging, resizing, and saving', flush=True)
        highlights_before = page.locator('.highlight-rect').count()
        page.locator('#textbox-tool').click(); expect(page.locator('#textbox-tool')).to_have_attribute('aria-pressed', 'true')
        pdf_box = page.locator('#pdf-page').bounding_box(); page.mouse.click(pdf_box['x'] + pdf_box['width'] * .7, pdf_box['y'] + pdf_box['height'] * .72)
        expect(page.locator('.floating-textbox')).to_have_count(2); expect(page.locator('#textbox-tool')).to_have_attribute('aria-pressed', 'true')
        standalone = page.locator('.floating-textbox').first; expect(standalone.locator('.textbox-color')).to_have_value('#356fa3'); standalone.locator('.textbox-editor').fill('Standalone text box')
        page.locator('#page-label').click(); expect(page.locator('#save-status')).to_have_text('All changes saved')
        assert page.locator('.highlight-rect').count() == highlights_before
        page.locator('#textbox-tool').click(); expect(page.locator('#textbox-tool')).to_have_attribute('aria-pressed', 'false')
        standalone.locator('.textbox-delete').click(); expect(page.locator('.floating-textbox')).to_have_count(1)
        print('PASS: standalone text box placement anywhere on the PDF without a highlight', flush=True)
        page.locator('#note-type-filter').select_option('textbox'); expect(page.locator('.note-card')).to_have_count(1); expect(page.locator('.note-card')).to_contain_text(TEXTBOX)
        page.locator('#note-type-filter').select_option('note'); expect(page.locator('.note-card')).to_have_count(1); expect(page.locator('.note-card')).to_contain_text(NOTE)
        page.locator('#note-type-filter').select_option('all'); page.locator('#note-color-filter').select_option('yellow'); expect(page.locator('.note-card')).to_have_count(1); expect(page.locator('.note-card')).to_contain_text(TEXTBOX)
        page.locator('#note-color-filter').select_option('all'); expect(page.locator('.note-card')).to_have_count(2)
        print('PASS: margin notes filter by type and highlight color', flush=True)
        page.locator('#zoom-in').click(); expect(page.locator('#zoom-fit')).to_have_text('120%')
        expect(page.locator('.highlight-rect').first).to_be_visible()
        page.locator('#next-page').click(); expect(page.locator('#page-input')).to_have_value('2')
        expect(page.locator('#save-status')).to_have_text('All changes saved')
        page.reload(); expect(page.locator('#reader-view')).to_be_visible(); expect(page.locator('#text-layer span').first).to_be_visible(); assert page.url == pdf_url
        expect(page.locator('#page-input')).to_have_value('2'); expect(page.locator('#zoom-fit')).to_have_text('120%')
        page.go_back(); expect(page.locator('#reader-view')).to_be_hidden(); expect(page.locator('#upload-status')).to_have_text(''); assert '#/pdf/' not in page.url
        page.go_forward(); expect(page.locator('#reader-view')).to_be_visible(); expect(page.locator('#page-input')).to_have_value('2')
        expect(page.locator('.note-card').filter(has_text=NOTE)).to_be_visible()
        page.locator('.note-card').filter(has_text=TEXTBOX).get_by_text('Show text box').click(); expect(page.locator('#page-input')).to_have_value('1')
        box = page.locator('.floating-textbox').first; expect(box.locator('.textbox-editor')).to_have_value(TEXTBOX)
        expect(box.locator('.textbox-size')).to_have_value('20'); expect(box.locator('.textbox-color')).to_have_value('#b64b4b')
        page.locator('.note-card').filter(has_text=NOTE).get_by_text('Go to passage').click(); expect(page.locator('#page-input')).to_have_value('1')
        expect(page.locator('.highlight-rect').first).to_be_visible()
        print('PASS: routed refresh and browser navigation preserve page, zoom, highlights, notes, and text boxes', flush=True)
        page.locator('.note-card').filter(has_text=NOTE).get_by_text('Edit', exact=True).click(); page.locator('#note-body').fill(NOTE + '\n已修改 / Đã sửa / Edited')
        page.locator('#save-note').click(); expect(page.locator('#note-dialog')).to_be_hidden()
        expect(page.locator('.note-card p')).to_contain_text('已修改')
        with page.expect_download() as download:
            page.locator('#export-notes').click()
        content = Path(download.value.path()).read_text(encoding='utf-8-sig'); assert NOTE in content and TEXTBOX in content
        print('PASS: edit and UTF-8 Markdown export', flush=True)
        page.screenshot(path=str(OUT / 'reader-desktop.png'))
        page.set_viewport_size({'width': 402, 'height': 874})
        expect(page.locator('#mobile-notes')).to_be_visible(); expect(page.locator('#notes-panel')).to_be_hidden()
        page.locator('#mobile-notes').click(); expect(page.locator('#notes-panel')).to_be_visible()
        page.locator('#new-note').click(); page.locator('#note-body').fill('手機筆記 · Ghi chú trên điện thoại'); page.locator('#save-note').click()
        expect(page.locator('#note-dialog')).to_be_hidden(); expect(page.locator('.note-card')).to_have_count(3)
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
        page.locator('#back-button').click(); expect(page.locator('#reader-view')).to_be_hidden(); assert '#/pdf/' not in page.url
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
