import {SETTINGS,check,openSettings,openSpaceDetails,showSidebar} from '../audit-fixtures.mjs';
import {GENERAL_WORKSPACE_MOCK} from '../general-workspace.mjs';
const shown='[data-space-pane][data-shown]';
const query='[data-command-palette] .ui-palette-head input';
async function palette(page){await page.keyboard.down('Meta');await page.keyboard.press('k');await page.keyboard.up('Meta');await page.waitForSelector(query);}
export default [
 {name:'walkthrough-r4-education',sizes:[[1100,720],[640,480]],mock:{settings:SETTINGS,threads:{},spaces:[{id:'school',name:'School',description:'',hue:240,educationEnabled:true},{id:'work',name:'Work',description:'',hue:50,educationEnabled:false}]},
 async run(page,h){
  await showSidebar(page);await h.click('[data-space-id="work"]');await page.waitForSelector('[data-space-pane="work"][data-shown]');
  await palette(page);
  for(const term of ['study','grades','plan','quiz']){
   await page.focus(query);await page.keyboard.down('Meta');await page.keyboard.press('a');await page.keyboard.up('Meta');await page.keyboard.type(term);
   check(await page.$$eval('[data-command]',items=>!items.some(e=>/^(view:(study|grades|plan)|study-due|make-quiz|make-flashcards)$/.test(e.dataset.command))),'noneducation palette omits '+term+' destinations');
  }
  await page.keyboard.press('Escape');await openSettings(page,h,'spaces');await openSpaceDetails(page,['work']);
  await page.$eval('[data-space-details="work"] [data-space-editor] [data-switch]',e=>e.click());
  await h.click('[data-space-details="work"] [data-space-save]');await page.waitForSelector('[data-space-details="work"] [data-space-saved]');
  await page.keyboard.press('Escape');await palette(page);await page.type(query,'study');await page.waitForSelector('[data-command="view:study"]');
  check(true,'saved Education setting immediately enables its palette destinations');
 }},
 {name:'walkthrough-r4-unread-collapse',sizes:[[1100,720]],mock:{settings:SETTINGS,threads:{},holdOpen:true,turn:[{kind:'text',delta:'Working on it.'}]},
 async run(page,h){
  await page.waitForSelector(`${shown} [data-composer-input]`);await h.send('Make a plan');await page.waitForSelector('[data-sidebar-thread="current"] [data-thread-state="running"]');
  await h.click('[data-space-id="work"]');await page.waitForSelector('[data-space-pane="work"][data-shown]');
  await h.click('[data-space-expand="school"]');
  await page.evaluate(()=>{window.__liveTurn.send({kind:'end',sessionId:null});window.__liveTurn=null;});
  await page.waitForSelector('[data-space-item="school"] [data-space-unread]');
  check(await page.$eval('#space-children-school',e=>e.hidden),'completion is tracked while the folder is collapsed');
  await h.click('[data-space-expand="school"]');await page.waitForSelector('[data-sidebar-conversations="school"] [data-thread-state="unread"]');
  await h.click('[data-space-expand="school"]');await h.click('[data-space-expand="school"]');
  check(!!await page.$('[data-sidebar-conversations="school"] [data-thread-state="unread"]'),'collapse and re-expansion preserve the conversation unread state');
  await h.click('[data-sidebar-conversations="school"] [data-sidebar-thread="current"]');
  await page.waitForFunction(()=>!document.querySelector('[data-space-item="school"] [data-space-unread]'));
  check(!await page.$('[data-sidebar-conversations="school"] [data-thread-state="unread"]'),'opening that conversation acknowledges it');
 }},
 {name:'walkthrough-r4-brand-permission',sizes:[[1100,720],[640,480]],mock:{...GENERAL_WORKSPACE_MOCK,fullAccess:['school']},
 async run(page,h){
  await h.click(`${shown} [data-model-picker]`);await page.waitForSelector('[data-access-picker] .ui-badge');
  const pill=await page.$eval('[data-access-picker] .ui-badge',e=>({text:e.textContent,background:getComputedStyle(e).backgroundColor}));
  check(pill.text.includes('Full access') && pill.background!=='rgba(0, 0, 0, 0)','Full access uses a persistent tinted Vic pill',JSON.stringify(pill));await h.shot('full-access');
  await h.click('[data-model-option="__other__"]');await page.waitForSelector('[data-cli-model-dialog]');
  check(await page.$eval('[data-cli-model-dialog]',e=>!e.textContent.includes('For example') && !e.textContent.includes('Enter a model name for')),'custom model keeps its label and placeholder without duplicate tutorials');
  await page.keyboard.press('Escape');await openSettings(page,h,'courses');await h.click('[data-course-overview-tab="sites"]');
  await page.waitForFunction(()=>{const img=document.querySelector('[data-course-site-brand="blackboard"] img');return img?.complete && img.naturalWidth===512;});
  check(true,'Blackboard renders its shipped official square image rather than a text placeholder');await h.shot('blackboard');
 }}
];
