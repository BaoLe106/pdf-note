"""Browser regression tests for practice using mocked HTTP; no production writes.
Run: uv run --with playwright python3 tests/practice_browser.py
Serve web/ on localhost:8000 first. Set CHROME_PATH if needed.
"""
import json
import os
import re
from playwright.sync_api import sync_playwright

OWNER='33333333-3333-4333-8333-333333333333'
CYCLE='11111111-1111-4111-8111-111111111111'
EXERCISE='22222222-2222-4222-8222-222222222222'
CONTENT=dict(title_zh='說清楚你的想法',title_en='Explain your view',prompt_zh='朋友想換工作，請給他建議。',passage_zh='朋友：我擔心不適應新環境。',instructions_zh='先回應顧慮，再提出建議。',instructions_en='Acknowledge, then suggest.',focus_zh='先說重點，再補充理由。',focus_en='Lead with the point.',hint_zh='可以用「也許」。',hint_en='Try perhaps.',format_label='Advice / 給建議',minutes=5,suggested_vocab=[dict(term='顧慮',meaning_zh='擔心的事情',meaning_en='concern',example_zh='我懂你的顧慮。',source_key='note:1',source_label='PDF · p.4')])
FEEDBACK={**{k+'_zh':'先回應對方的擔心。' for k in ['summary','strength','structure','naturalness','explanation','next_step']},**{k+'_en':'Acknowledge their concern.' for k in ['summary','strength','structure','naturalness','explanation','next_step']},'revision_zh':'我懂你的顧慮，也許可以先問問看。','organization':3,'clarity':4,'naturalness':3,'relevance':4}

def main():
 with sync_playwright() as p:
  browser=p.chromium.launch(executable_path=os.environ.get('CHROME_PATH','/usr/bin/google-chrome'))
  page=browser.new_page(viewport={'width':1440,'height':1000});errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  state={'drafts':[],'attempts':[],'fail_save':False}
  token={'access_token':'test-token','refresh_token':'test-refresh','expires_at':4102444800,'expires_in':3600,'token_type':'bearer','user':{'id':OWNER,'aud':'authenticated','role':'authenticated','email':'test@example.invalid'}}
  page.add_init_script(f"localStorage.setItem('sb-etyubwsyrfzteckfmhtt-auth-token',JSON.stringify({json.dumps(token)}));")
  def route(r):
   action=r.request.url.split('action=')[-1];body=r.request.post_data_json or {};status=200
   if action=='dashboard':result={'current':CYCLE,'selected':CYCLE,'cycles':[{'id':CYCLE,'starts_on':'2026-11-22','ends_on':'2026-12-05','status':'ready'}],'exercises':[{'id':EXERCISE,'position':1,'content':CONTENT}],'drafts':state['drafts'],'settings':{'sheet_status':'ready','image_total':10,'image_processed':10},'recent':state['attempts'],'source_counts':{'pdf':189,'sheet':534,'image':10}}
   elif action=='save':
    if state['fail_save']:status=409;result={'error':'Draft changed in another tab'}
    else:
     draft={'exercise_id':EXERCISE,'answer':body['answer'],'revision':body['revision']+1,'completed_at':'2026-11-22' if body.get('complete') else None};state['drafts']=[draft];result={'draft':draft}
   elif action=='attempts':result={'attempts':state['attempts']}
   elif action=='review':
    a={'id':body['id'],'exercise_id':EXERCISE,'answer':body['answer'],'created_at':'2026-11-22T12:00:00Z','feedback':FEEDBACK,'status':'ready'};state['attempts']=[a];result={'attempt':a}
   else:result={'ok':True}
   r.fulfill(status=status,content_type='application/json',body=json.dumps(result))
  page.route('**/functions/v1/homework?*',route)
  page.goto('http://localhost:8000/homework.html');page.locator('#hw-continue').click();page.locator('#hw-hint-toggle').click();assert page.locator('#hw-hint').is_visible();assert page.locator('#hw-suggested').inner_text().find('顧慮')>=0
  page.locator('#hw-answer').fill('我懂你的顧慮。<img src=x onerror=alert(1)>');page.locator('#hw-review').click();page.locator('#hw-feedback').wait_for(state='visible');assert page.locator('#hw-feedback img').count()==0;assert '我懂你的顧慮' in page.locator('#hw-history').text_content()
  page.locator('#hw-complete').click();page.locator('#hw-back').click();assert '1 / 60' in page.locator('#hw-completion').inner_text()
  page.locator('[data-tab=vocab]').click();page.locator('#hw-search').fill('absent');assert '尚無' in page.locator('#hw-vocab-content').inner_text();page.locator('[data-tab=home]').click();page.locator('#hw-continue').click()
  state['fail_save']=True;page.locator('#hw-answer').fill('新的草稿，不要遺失。');page.locator('#hw-back').click();page.wait_for_function("document.getElementById('toast').textContent.includes('Draft changed')");assert page.locator('#hw-practice').is_visible();assert page.locator('#hw-answer').input_value()=='新的草稿，不要遺失。';state['fail_save']=False;page.locator('#hw-save').click();page.wait_for_function("document.getElementById('hw-save-status').textContent.includes('已儲存至帳號')")
  for width in [1440,768,390]:
   page.set_viewport_size({'width':width,'height':950});assert page.evaluate('document.documentElement.scrollWidth<=innerWidth'),width
  page.reload();page.locator('#hw-answer').wait_for(state='visible');assert page.locator('#hw-answer').input_value()=='新的草稿，不要遺失。'
  assert not errors,errors
  print('PASS: bilingual guidance, suggested vocab, feedback, XSS-safe rendering, draft persistence, conflict protection, completion, filters, deep-link refresh, responsive layout.')
  page.screenshot(path='/tmp/pdf-note-practice-mobile.png',full_page=True)
  browser.close()

if __name__=='__main__':main()
