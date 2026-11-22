import { TOTAL, FORMATS, batchPlan, validateExercises, validateFeedback, vocabularyCandidates, exerciseSchemaFor } from '../supabase/functions/homework/core.ts';
function assert(v:unknown){if(!v)throw Error('Assertion failed');}
function rejects(f:()=>unknown){let threw=false;try{f();}catch{threw=true;}assert(threw);}
Deno.test('vocabulary choices are constrained to short literal source text',()=>{
 const sources=[{content:'A1: 安排：arrange\n週末 weekend\n這是一段非常長的完整句子不能當成一個單字'},{content:'安排\n邀請'}];
 const terms=vocabularyCandidates(sources);
 assert(terms.join(',')==='安排,週末,邀請');
 const schema:any=exerciseSchemaFor(terms);
 assert(schema.properties.exercises.items.properties.suggested_vocab.items.properties.term.enum.every((t:string)=>sources.some(s=>s.content.includes(t))));
 assert((exerciseSchemaFor(terms,'reading') as any).properties.exercises.items.properties.passage_zh.minLength===1);
 assert((exerciseSchemaFor(terms,'rewrite') as any).properties.exercises.items.properties.passage_zh.minLength===1);
 assert(schema.properties.exercises.items.properties.passage_zh.minLength===0);
});
const sample=()=>({title_zh:'說明你的想法',title_en:'Explain your view',prompt_zh:'你會如何安排週末？',passage_zh:'朋友想在週末一起旅行。',instructions_zh:'說明你的理由。',instructions_en:'Explain why.',focus_zh:'先說重點，再補充理由。',focus_en:'Main point, then reasons.',hint_zh:'可以先說自己的想法。',hint_en:'Start with your view.',minutes:5,suggested_vocab:[{term:'安排',meaning_zh:'規劃事情',meaning_en:'arrange',example_zh:'我們先安排時間。',source_key:'note:1'},{term:'週末',meaning_zh:'一週結束的假日',meaning_en:'weekend',example_zh:'週末一起出門吧。',source_key:'sheet:2'}]});
Deno.test('twelve distinct formats cover sixty positions with no gaps',()=>{const positions:number[]=[];for(let i=0;i<FORMATS.length;i++){const p=batchPlan(i);for(let j=0;j<p.count;j++)positions.push(p.start+j);}assert(new Set(FORMATS.map(f=>f[0])).size===12);assert(positions.length===TOTAL);assert(positions.every((v,i)=>v===i+1));});
Deno.test('generation rejects missing source attribution, missing reading, invalid batch size',()=>{const sources=new Set(['note:1','sheet:2']);const data={exercises:Array.from({length:5},sample)};assert(validateExercises(data,sources,'reading').length===5);rejects(()=>validateExercises({exercises:[sample()]},sources,'reading'));const missing={exercises:Array.from({length:5},sample)};missing.exercises[0].passage_zh='';rejects(()=>validateExercises(missing,sources,'reading'));data.exercises[0].suggested_vocab[0].source_key='invented';rejects(()=>validateExercises(data,sources,'message'));});
Deno.test('feedback needs actual bilingual coaching and bounded scores',()=>{const f:any={};for(const k of ['summary','strength','structure','naturalness','explanation','next_step']){f[k+'_zh']='先說重點';f[k+'_en']='Lead with the main point';}f.revision_zh='我覺得可以先試試看。';for(const k of ['organization','clarity','naturalness','relevance'])f[k]=3;assert(validateFeedback(f)===f);rejects(()=>validateFeedback({...f,organization:10}));rejects(()=>validateFeedback({...f,structure_zh:''}));});
