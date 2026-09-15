"""Touch viewport check using Playwright's WebKit (Safari engine)."""
import os
from playwright.sync_api import sync_playwright, expect
from browser_smoke import fixture, TITLE, NOTE, OUT, BASE, select_chinese

with sync_playwright() as p:
    browser = p.webkit.launch()
    context = browser.new_context(viewport={'width': 402, 'height': 874}, device_scale_factor=3, is_mobile=True, has_touch=True)
    page = context.new_page(); errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('dialog', lambda d: d.accept())
    page.set_default_timeout(45000)
    page.goto(BASE); page.locator('#password').fill(os.environ['PDF_NOTE_PASSWORD']); page.locator('#login-button').click()
    expect(page.locator('#app-view')).to_be_visible(); expect(page.locator('#upload-status')).to_have_text('')
    page.locator('#file-input').set_input_files(fixture())
    expect(page.locator('#text-layer span').first).to_be_visible()
    select_chinese(page)
    page.locator('#note-selection').tap(); expect(page.locator('#note-dialog')).to_be_visible()
    page.locator('#note-body').fill(NOTE); page.locator('#save-note').tap()
    expect(page.locator('#note-dialog')).to_be_hidden(); expect(page.locator('.highlight-rect').first).to_be_visible()
    page.locator('#mobile-notes').tap(); expect(page.locator('.note-card p')).to_have_text(NOTE)
    page.screenshot(path=str(OUT / 'webkit-mobile-notes.png'))
    page.locator('#close-notes').tap(); page.locator('#next-page').tap()
    expect(page.locator('#page-input')).to_have_value('2'); expect(page.locator('#save-status')).to_have_text('All changes saved')
    page.reload(); expect(page.locator('#upload-status')).to_have_text('')
    page.locator('.project-card').filter(has_text=TITLE).locator('.project-name').first.tap()
    expect(page.locator('#page-input')).to_have_value('2')
    page.locator('#mobile-notes').tap(); page.locator('.note-card').get_by_text('Go to passage').tap()
    expect(page.locator('.highlight-rect').first).to_be_visible()
    page.screenshot(path=str(OUT / 'webkit-mobile-reader.png'))
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    page.locator('#back-button').tap(); expect(page.locator('#reader-view')).to_be_hidden()
    page.locator('.project-card').filter(has_text=TITLE).locator('.project-delete').first.tap()
    expect(page.locator('.project-card').filter(has_text=TITLE)).to_have_count(0)
    page.locator('#logout-button').tap(); expect(page.locator('#login-view')).to_be_visible()
    assert not errors, errors
    browser.close()
    print('PASS: WebKit touch viewport login, upload, Chinese selection, notes, highlights, page persistence, deletion, and logout')
