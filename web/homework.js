import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.57.4/+esm';
const $=id=>document.getElementById(id),config=window.PDF_NOTE_CONFIG;
const client=createClient(config.supabaseUrl,config.supabaseAnonKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false}});
let data=null,current=null,session=null,drafts=new Map(),dirty=false,saveTimer,pollTimer,reviewTimer,toastTimer,saveQueue=Promise.resolve(),loading=false,reviewBusy=false,screen='home',epoch=0;
const el=(tag,text,className)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(className)n.className=className;return n;};
function toast(text){$('toast').textContent=text;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,6000);}
function bilingual(parent,zh,en){parent.append(el('p',zh),el('p',en,'muted'));}
async function api(action,body={}){
 const {data:{session:s}}=await client.auth.getSession();if(!s)throw Error('Please sign in again. / 請重新登入。');
 const invoke=token=>fetch(`${config.supabaseUrl}/functions/v1/homework?action=${action}`,{method:'POST',headers:{Authorization:`Bearer ${token}`,apikey:config.supabaseAnonKey,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(110000)});
 let res=await invoke(s.access_token);if(res.status===401){const refreshed=await client.auth.refreshSession();if(!refreshed.data.session)throw Error('Your session expired. / 登入已過期。');res=await invoke(refreshed.data.session.access_token);}
 const result=await res.json();if(!res.ok)throw Error(result.error||'Request failed. / 請稍後再試。');return result;
}
const completed=()=>data?.exercises.filter(e=>drafts.get(e.id)?.completed_at).length||0;
function view(name){screen=name;for(const v of ['home','practice','progress','vocab'])$('hw-'+v).hidden=v!==name;document.querySelectorAll('[data-tab]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.tab===(name==='practice'?'home':name))));if(name==='home')renderTasks();if(name==='progress')renderProgress();if(name==='vocab')renderVocab();}
async function navigate(name){await saveDraft();clearTimeout(reviewTimer);view(name);if(name!=='practice')history.replaceState(null,'',location.pathname+location.search);}
async function refresh(){
 if(!session||loading)return;loading=true;const generation=epoch;if(!data)$('hw-status').textContent='Loading your practice… / 正在載入練習…';
 try{
  const selected=new URLSearchParams(location.search).get('cycle');const result=await api('dashboard',selected?{cycle_id:selected}:{});if(generation!==epoch)return;
  data=result;for(const d of data.drafts){if(d.exercise_id!==current?.id||!dirty){
   if(d.exercise_id===current?.id&&!dirty&&d.revision!==drafts.get(d.exercise_id)?.revision){$('hw-answer').value=d.answer;updateEditor();}
   drafts.set(d.exercise_id,d);
  }}
  const cycle=data.cycles.find(c=>c.id===data.selected);$('hw-cycle').replaceChildren(...data.cycles.map(c=>{const option=el('option',`${c.starts_on} – ${c.ends_on}`);option.value=c.id;option.selected=c.id===data.selected;return option;}));
  $('hw-generation').textContent=cycle.status==='ready'?'60 exercises ready / 60 題已備妥':`${data.exercises.length} / 60 prepared / 題已備妥。You can start with the available exercises. / 可先練習已備妥的題目。`;
  $('hw-retry').hidden=cycle.status!=='failed';$('hw-status').textContent=cycle.error||data.settings.sync_error||'';
  $('hw-sources').textContent=`PDF notes / 筆記：${data.source_counts.pdf}\nSheet rows / 試算表資料列：${data.source_counts.sheet}\nImages read / 已讀取圖片：${data.source_counts.image}`;$('hw-sources').style.whiteSpace='pre-line';
  $('hw-images').textContent=`圖片處理 ${data.settings.image_processed} / ${data.settings.image_total} · ${data.settings.sheet_status==='ready'?'同步完成 / Synced':'同步中 / Import pending'}. Sheet sync runs daily. / 試算表每日同步。`;
  renderTasks();if(screen==='progress')renderProgress();if(screen==='vocab')renderVocab();
  clearTimeout(pollTimer);if(data.cycles.find(c=>c.id===data.current)?.status==='generating')pollTimer=setTimeout(refresh,15000);
 }catch(e){if(generation===epoch)$('hw-status').textContent=e.message;}finally{loading=false;}
}
function renderTasks(){
 if(!data)return;const count=completed();$('hw-completion').textContent=`${count} / 60 practised · 已練習`;$('hw-meter').value=count;$('hw-continue').disabled=!data.exercises.length;$('hw-continue').textContent=count?'Continue / 繼續練習 →':'Start practice / 開始練習 →';
 $('hw-tasks').replaceChildren();const filter=$('hw-filter').value;
 for(const e of data.exercises){const draft=drafts.get(e.id),done=!!draft?.completed_at;if(filter==='done'&&!done||filter==='remaining'&&done)continue;
  const b=el('button',undefined,'hw-task'+(done?' done':''));const label=el('span');label.append(el('strong',e.content.title_zh),el('small',e.content.title_en),el('small',e.content.format_label+` · ${e.content.minutes} min`));b.append(el('span',done?'✓':String(e.position).padStart(2,'0')),label,el('span',done?'已練習':draft?.answer?'草稿':'待練習','hw-pill'));b.onclick=()=>openExercise(e).catch(e=>toast(e.message));$('hw-tasks').append(b);
 }
 if(!$('hw-tasks').children.length)$('hw-tasks').append(el('p','No exercises in this view yet. / 此處尚無練習。','hw-empty'));
}
function wordCard(v){const card=el('div',undefined,'hw-word');card.append(el('strong',v.term));bilingual(card,v.meaning_zh,v.meaning_en);card.append(el('p',v.example_zh,'hw-example'),el('small','來源 / Source: '+(v.source_label||v.source_key)));return card;}
async function openExercise(e){await saveDraft();clearTimeout(reviewTimer);current=e;dirty=false;reviewBusy=false;const c=e.content;
 $('hw-title').textContent=c.title_zh;$('hw-title-en').textContent=c.title_en;$('hw-position').textContent=`${e.position} / 60`;$('hw-kind').textContent=c.format_label;$('hw-prompt').textContent=c.prompt_zh;$('hw-passage').textContent=c.passage_zh;$('hw-passage').hidden=!c.passage_zh;
 for(const [id,zh,en] of [['hw-instructions',c.instructions_zh,c.instructions_en],['hw-focus',c.focus_zh,c.focus_en],['hw-hint',c.hint_zh,c.hint_en]]){$(id).replaceChildren();bilingual($(id),zh,en);}
 $('hw-hint').hidden=true;$('hw-hint-toggle').setAttribute('aria-expanded','false');$('hw-suggested').replaceChildren(...c.suggested_vocab.map(wordCard));$('hw-answer').value=drafts.get(e.id)?.answer||'';$('hw-save-status').textContent=drafts.has(e.id)?'Saved / 已儲存':'Draft / 草稿';$('hw-feedback').hidden=true;$('hw-feedback-status').textContent='';$('hw-history').replaceChildren();updateEditor();view('practice');
 history.replaceState(null,'',`${location.pathname}${location.search}#/exercise/${e.id}`);$('hw-title').focus({preventScroll:true});window.scrollTo({top:0,behavior:'instant'});await loadAttempts(e.id);
}
function updateEditor(){$('hw-chars').textContent=`${$('hw-answer').value.length} / 6,000`;$('hw-review').disabled=!$('hw-answer').value.trim()||reviewBusy;$('hw-complete').disabled=!$('hw-answer').value.trim();}
function saveDraft(complete=false){
 clearTimeout(saveTimer);if(!current||(!dirty&&!complete))return saveQueue;
 const exercise=current,answer=$('hw-answer').value;const ownEpoch=epoch;
 const job=saveQueue.catch(()=>{}).then(async()=>{
  if(ownEpoch!==epoch)return;
  const old=drafts.get(exercise.id);if(!complete&&old?.answer===answer){if(current?.id===exercise.id&&$('hw-answer').value===answer)dirty=false;return;}
  const result=await api('save',{exercise_id:exercise.id,answer,revision:old?.revision||0,complete});if(ownEpoch!==epoch)return;
  drafts.set(exercise.id,result.draft);if(current?.id===exercise.id&&$('hw-answer').value===answer){dirty=false;$('hw-save-status').textContent='Saved to your account / 已儲存至帳號';}renderTasks();
 });saveQueue=job;return job;
}
function showFeedback(a){const parent=$('hw-feedback');parent.replaceChildren();parent.hidden=false;parent.append(el('span','AI coaching / AI 練習回饋','eyebrow'));
 const f=a.feedback;bilingual(parent,f.summary_zh,f.summary_en);
 const matching=current&&a.answer===$('hw-answer').value.trim();parent.append(el('p',matching?'Feedback for this answer / 本次回答的回饋':'Feedback for an earlier answer shown below / 以下回饋對應先前的回答','small muted'));
 const source=el('details');source.append(el('summary','Reviewed answer / 回饋對應的答案'),el('p',a.answer));parent.append(source);
 for(const [label,key] of [['What works / 做得好的地方','strength'],['Organize your ideas / 組織想法','structure'],['Make it natural / 自然表達','naturalness']]){parent.append(el('h3',label));bilingual(parent,f[key+'_zh'],f[key+'_en']);}
 parent.append(el('h3','One possible revision / 一種改寫方式'),el('div',f.revision_zh,'hw-revision'));bilingual(parent,f.explanation_zh,f.explanation_en);parent.append(el('h3','Try this next / 下一步試試'));bilingual(parent,f.next_step_zh,f.next_step_en);
 const revise=el('button','Revise my answer / 修改我的回答','secondary');revise.onclick=()=>{$('hw-answer').focus();$('hw-answer').scrollIntoView({behavior:'smooth',block:'center'});};parent.append(revise);
}
async function loadAttempts(id){
 try{const result=await api('attempts',{exercise_id:id});if(current?.id!==id||!session)return;
  $('hw-history').replaceChildren();for(const a of result.attempts){const item=el('details',undefined,'hw-attempt');item.append(el('summary',new Date(a.created_at).toLocaleString()+` · ${a.status==='ready'?'已回饋':a.status==='pending'?'處理中':'需重試'}`),el('p',a.answer));if(a.feedback){const b=el('button','View feedback / 查看回饋','text-button');b.onclick=()=>showFeedback(a);item.append(b);}if(a.error)item.append(el('p',a.error,'hw-error'));$('hw-history').append(item);}
  const latest=result.attempts[0];if(!latest)return;
  if(latest.status==='pending'&&Date.now()-Date.parse(latest.created_at)<180000){reviewBusy=true;updateEditor();$('hw-feedback-status').textContent='Preparing feedback… Your answer is saved. / 正在準備回饋，答案已儲存。';reviewTimer=setTimeout(()=>loadAttempts(id),4000);}
  else{reviewBusy=false;updateEditor();$('hw-feedback-status').textContent=latest.status==='ready'?'':latest.error||'Feedback timed out. Submit again to retry. / 回饋逾時，可再次送出重試。';if(latest.feedback)showFeedback(latest);}
 }catch(e){reviewBusy=false;updateEditor();$('hw-feedback-status').textContent=e.message;}
}
async function submit(){if(!current||reviewBusy)return;await saveDraft();const id=current.id,answer=$('hw-answer').value.trim();reviewBusy=true;updateEditor();$('hw-feedback-status').textContent='Submitting… / 正在送出…';
 try{await api('review',{id:crypto.randomUUID(),exercise_id:id,answer});if(current?.id===id)await loadAttempts(id);}catch(e){reviewBusy=false;updateEditor();$('hw-feedback-status').textContent=e.message;}
}
function renderProgress(){if(!data)return;const parent=$('hw-progress-content');parent.replaceChildren();const latest=new Map();for(const a of data.recent)if(!latest.has(a.exercise_id))latest.set(a.exercise_id,a);
 const samples=[...latest.values()];const metrics=el('div',undefined,'hw-metrics');for(const [name,key] of [['Organization / 組織','organization'],['Clarity / 清楚度','clarity'],['Natural phrasing / 自然度','naturalness'],['Relevance / 切題','relevance']]){const card=el('article',undefined,'hw-card hw-metric');card.append(el('span',name,'small'),el('strong',samples.length?(samples.reduce((s,a)=>s+a.feedback[key],0)/samples.length).toFixed(1)+' / 5':'—'),el('p',samples.length?`${samples.length} recent exercises / 題近期練習`:'Submit an answer to begin. / 作答後開始記錄。','small'));metrics.append(card);}parent.append(metrics);
 parent.append(el('p',`本期完成 ${completed()} / 60。每題只採最近一次回饋（最多 30 次近期紀錄），避免重複修改拉高平均。這些分數不代表口說流利度或發音。\nThis cycle: ${completed()} / 60. Averages use the latest feedback per exercise within the 30 most recent reviewed attempts; they do not measure spoken fluency or pronunciation.`));
 for(const a of samples.slice(0,5)){const card=el('article',undefined,'hw-card hw-section');card.append(el('span',new Date(a.created_at).toLocaleDateString(),'small muted'),el('h3','Next step / 下一步'));bilingual(card,a.feedback.next_step_zh,a.feedback.next_step_en);parent.append(card);}
}
function renderVocab(){if(!data)return;const words=new Map();for(const e of data.exercises)for(const v of e.content.suggested_vocab)if(!words.has(v.term))words.set(v.term,v);const q=$('hw-search').value.trim().toLocaleLowerCase();const filtered=[...words.values()].filter(v=>[v.term,v.meaning_en,v.meaning_zh].join(' ').toLocaleLowerCase().includes(q));$('hw-vocab-content').replaceChildren(...filtered.map(v=>{const c=el('article',undefined,'hw-card');c.append(wordCard(v));return c;}));if(!filtered.length)$('hw-vocab-content').append(el('p','No matching suggestions yet. / 尚無符合的建議用詞。'));}
function safely(fn){return ()=>Promise.resolve().then(fn).catch(e=>toast(e.message));}
document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=safely(()=>navigate(b.dataset.tab)));
$('hw-continue').onclick=safely(()=>{if(data?.exercises.length)return openExercise(data.exercises.find(e=>!drafts.get(e.id)?.completed_at)||data.exercises[0]);});
$('hw-back').onclick=safely(()=>navigate('home'));$('hw-filter').onchange=renderTasks;$('hw-search').oninput=renderVocab;
$('hw-answer').oninput=()=>{dirty=true;$('hw-save-status').textContent='Unsaved changes / 尚未儲存';updateEditor();clearTimeout(saveTimer);saveTimer=setTimeout(()=>saveDraft().catch(e=>{$('hw-save-status').textContent=e.message;}),1000);};
$('hw-save').onclick=safely(()=>saveDraft());$('hw-review').onclick=safely(submit);
$('hw-complete').onclick=safely(async()=>{await saveDraft(true);toast('Practice recorded / 已記錄練習');});
$('hw-next').onclick=safely(async()=>{const next=data.exercises.find(e=>e.position===current.position+1);if(next)await openExercise(next);else await navigate('home');});
$('hw-hint-toggle').onclick=()=>{$('hw-hint').hidden=!$('hw-hint').hidden;$('hw-hint-toggle').setAttribute('aria-expanded',String(!$('hw-hint').hidden));};
$('hw-refresh').onclick=safely(async()=>{await saveDraft();await refresh();});
$('hw-retry').onclick=safely(async()=>{await api('retry');await refresh();});
$('hw-sync').onclick=safely(async()=>{await api('sync-notes');toast('PDF note sync requested / 已要求同步 PDF 筆記');await refresh();});
$('hw-cycle').onchange=safely(async()=>{await saveDraft();current=null;drafts=new Map();history.replaceState(null,'',location.pathname+'?cycle='+$('hw-cycle').value);await refresh();view('home');});
window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
async function signedIn(s){session=s;$('hw-login').hidden=!!s;$('hw-app').hidden=!s;if(s){await refresh();const id=location.hash.match(/^#\/exercise\/([a-f0-9-]{36})$/i)?.[1];const e=data?.exercises.find(e=>e.id===id);if(e)await openExercise(e);}}
function clearSession(){epoch++;session=null;data=null;current=null;dirty=false;drafts.clear();clearTimeout(pollTimer);clearTimeout(reviewTimer);clearTimeout(saveTimer);$('hw-answer').value='';$('hw-tasks').replaceChildren();$('hw-feedback').replaceChildren();$('hw-history').replaceChildren();$('hw-progress-content').replaceChildren();$('hw-vocab-content').replaceChildren();$('hw-app').hidden=true;$('hw-login').hidden=false;}
$('hw-login-form').onsubmit=async e=>{e.preventDefault();$('hw-login-submit').disabled=true;$('hw-login-error').textContent='';try{if($('hw-username').value.trim().toLowerCase()!=='baole106')throw Error('Incorrect username or password.');const result=await client.auth.signInWithPassword({email:config.loginEmail,password:$('hw-password').value});if(result.error)throw Error('Incorrect username or password.');$('hw-password').value='';await signedIn(result.data.session);}catch(err){$('hw-login-error').textContent=err.message;}finally{$('hw-login-submit').disabled=false;}};
$('hw-logout').onclick=safely(async()=>{await saveDraft();const result=await client.auth.signOut();if(result.error)throw result.error;clearSession();});
client.auth.onAuthStateChange(event=>{if(event==='SIGNED_OUT')clearSession();});
client.auth.getSession().then(({data:{session:s}})=>signedIn(s)).catch(e=>{$('hw-login-error').textContent=e.message;});
