import {SETTINGS, check} from '../audit-fixtures.mjs';
const shown='[data-space-pane][data-shown]';
const calls=(page,cmd)=>page.evaluate(cmd=>window.__calls.filter(([name])=>name===cmd).map(([,args])=>args),cmd);
const models=[
  {id:'claude-opus-5-5',name:'Claude Opus 5.5',aliases:['opus'],reasoningEfforts:['low','medium','high','xhigh','max'],defaultReasoningEffort:'medium'},
  {id:'claude-sonnet-5-5',name:'Claude Sonnet 5.5',aliases:['sonnet'],reasoningEfforts:['low','medium','high'],defaultReasoningEffort:'high'},
  {id:'claude-haiku-4-5',name:'Claude Haiku 4.5',aliases:['haiku']},
];
const mock={settings:{...SETTINGS,backend:'claude-cli'},threads:{},slow:{agent_instance_models:300},cliLists:{claude:{models,defaultModel:'claude-opus-5-5',note:'Claude Code can’t list its models: these are the names its help gives.'}}};
async function open(page,h){await page.waitForSelector(`${shown} [data-model-picker]`);await h.click(`${shown} [data-model-picker]`);await page.waitForSelector('[data-effort-level="max"]');}
export default [
 {
  name:'model-reasoning-r4',sizes:[[1100,720],[640,480]],mock,
  async run(page,h){
   await open(page,h);
   check(!await page.$('[data-cli-models-note]'),'successful catalogs omit the old explanatory paragraph');
   check(await page.$eval(`${shown} [data-model-picker]`,e=>e.textContent.includes('Claude Opus 5.5')),'resolved default model has its actual full name');
   check(await page.$$eval('[data-model-list] [data-model-option]',rows=>rows.filter(e=>e.textContent.trim()==='Opus').length===0),'canonical model names replace standalone help aliases');
   check(await page.$eval('[data-effort-level="default"]',e=>e.getAttribute('aria-checked')==='true'),'Default leaves the CLI effort unspecified');
   const layout=await page.$eval('[data-model-menu]',root=>({list:root.querySelector('.ph-model-list-column').getBoundingClientRect().width,last:root.querySelector('[data-effort-level="max"]').getBoundingClientRect().bottom,column:root.querySelector('[data-model-picker-effort]').getBoundingClientRect().bottom,right:root.getBoundingClientRect().right}));
   check(layout.list>=240 && layout.last<=layout.column+1,'full model names and every native effort level fit the docked picker',JSON.stringify(layout));
   await h.click('[data-model-option="__refresh__"]');
   check(await page.$eval(`${shown} [data-model-picker]`,e=>e.textContent.includes('Claude Opus 5.5')),'refresh retains the resolved default name while discovery runs');
   await page.waitForFunction(()=>!document.querySelector('[data-model-option="__refresh__"]')?.disabled);
   await h.shot('default');
   await h.click('[data-effort-level="xhigh"]');
   await page.waitForFunction(()=>document.querySelector('[data-effort-level="xhigh"]')?.getAttribute('aria-checked')==='true');
   const set=(await calls(page,'space_reasoning_set')).at(-1);
   check(set.cli==='claude' && set.model===null && set.effort==='xhigh','choosing effort saves the exact CLI/default-model preference');
   check(await page.evaluate(()=>document.activeElement?.dataset.effortLevel==='xhigh'),'async effort saving retains keyboard focus on the chosen level');
   await page.keyboard.press('Escape');
   await page.waitForFunction(()=>!document.querySelector('[data-model-menu]'),{timeout:4000});
   await h.click(`${shown} [data-model-picker]`);
   await page.waitForFunction(()=>document.querySelector('[data-effort-level="xhigh"]')?.getAttribute('aria-checked')==='true');
   check(await page.$eval(`${shown} [data-composer-effort]`,e=>e.textContent==='Extra high'),'saved reasoning appears in the composer and survives reopening');
   await h.click('[data-model-option="claude-sonnet-5-5"]');
   await page.waitForFunction(()=>document.querySelector('[data-model-picker-effort]')?.textContent.includes('Claude Sonnet 5.5'));
   check(!await page.$('[data-effort-level="xhigh"]'),'each model exposes only its own supported levels');
   check((await calls(page,'space_model_set')).at(-1)?.model==='claude:claude-sonnet-5-5','model selection persists the full canonical ID');
   await h.click('[data-effort-level="high"]');
   await page.waitForFunction(()=>document.querySelector('[data-effort-level="high"]')?.getAttribute('aria-checked')==='true');
   check((await calls(page,'space_reasoning_set')).at(-1)?.model==='claude-sonnet-5-5','explicit models keep separate effort preferences');
   await h.shot('selected');
   await h.click('[data-effort-level="default"]');
   await page.waitForFunction(()=>document.querySelector('[data-effort-level="default"]')?.getAttribute('aria-checked')==='true');
   check((await calls(page,'space_reasoning_set')).at(-1)?.effort===null,'Default removes the override');
   await page.focus('[data-effort-level="default"]');await page.keyboard.press('ArrowDown');
   check(await page.evaluate(()=>document.activeElement?.dataset.effortLevel==='low'),'arrow keys move between actual effort rows');
   await page.keyboard.press('ArrowLeft');
   check(await page.evaluate(()=>document.activeElement?.matches('[data-model-search] input')),'Left returns from the effort column to model search');
   await h.click('[data-model-option="claude-haiku-4-5"]');
   await page.waitForFunction(()=>!document.querySelector('[data-model-menu]'));
   check(!await page.$('[data-model-picker-effort]'),'models without reasoning do not gain invented controls');
  }
 },
 {
  name:'model-reasoning-r4-save-error',mock:{...mock,fail:{space_reasoning_set:'Disk unavailable.'}},
  async run(page,h){await open(page,h);await h.click('[data-effort-level="high"]');await page.waitForSelector('[data-model-picker-effort] [role="alert"]');check(await page.$eval('[data-effort-level="default"]',e=>e.getAttribute('aria-checked')==='true'),'failed persistence retains the previous effort');check(!!await page.$('[data-model-menu]'),'save failure retains the picker for retry');}
 }
];
