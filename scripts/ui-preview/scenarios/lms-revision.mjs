// LMS revision: scale through selection, keep imports cancellable, open actual course sources.
import { SETTINGS, check } from '../audit-fixtures.mjs';
const ALL=['overview','syllabus','assignments','announcements','files','grades'];
const course={id:'101',name:'Discrete Structures',code:'CSCI-C 241',term:'Fall 2026',current:true};
const connection={id:'c1',kind:'canvas',address:'https://iu.instructure.com',schoolName:'Indiana University',signedIn:true,courses:['101']};
async function sites(page){
 await page.waitForSelector('[data-composer-input]');
 await page.keyboard.down('Meta'); await page.keyboard.press(','); await page.keyboard.up('Meta');
 await page.waitForSelector('[data-testid="settings-tab-courses"]');
 await page.click('[data-testid="settings-tab-courses"]');
 await page.waitForSelector('[data-course-navigator]');
}
export default [
 {
  name:'lms-revision-sources',sizes:[[1100,720],[640,480]],mock:{settings:SETTINGS,threads:{},lms:{list:[connection,{...connection,id:'m1',kind:'moodle',schoolName:'Learning Academy',address:'https://moodle.example.edu',courses:[]},{...connection,id:'b1',kind:'blackboard',schoolName:'Blackboard Campus',address:'https://learn.example.edu',courses:[]}],courses:[course,{...course,id:'102',name:'Calculus II'}]},courseAccess:{school:{'c1/101':ALL}},lmsContent:{'c1/101':[{path:'courses/Discrete Structures/modules.md',title:'Unit one',kind:'module',anchor:'unit-one'},{path:'courses/Discrete Structures/modules.md',title:'Unit two',kind:'module',anchor:'unit-two'},{path:'courses/Discrete Structures/files/notes.md',title:'Lecture notes',kind:'file',bytes:1024}]},files:{'courses/Discrete Structures/modules.md':{kind:'markdown',text:'# Course modules\n\n## Unit one\n\nLogic\n\n## Unit two\n\nProofs'},'courses/Discrete Structures/files/notes.md':{kind:'markdown',text:'# Lecture notes\n\nLecture source content'}}},
  async run(page,h){
   await sites(page);
   await page.click('[data-course-overview-tab="sites"]');
   const shape=await page.evaluate(()=>({sites:document.querySelectorAll('[data-site-row]').length,grids:document.querySelectorAll('[data-access-grid]').length,marks:[...document.querySelectorAll('[data-site-row] [data-course-site-brand]')].map(e=>{const r=e.getBoundingClientRect();return [r.width,r.height]})}));
   check(shape.sites===3&&shape.grids===0,'connected accounts share compact rows without stacking course detail',JSON.stringify(shape));
   check(shape.marks.every(([w,h])=>Math.abs(w-h)<1),'every site mark uses a square frame',JSON.stringify(shape.marks));
   await h.shot('settings');
   await page.click('[data-course-overview-tab="courses"]');
   await page.click('[data-course-select="c1/101"]');
   await page.click('[data-browse-course]');
   await page.waitForSelector('[data-course-content-open]');
   await h.shot('content');
   check(await page.$$eval('[data-course-content-open^="courses/Discrete Structures/modules.md#"]',rows=>rows.length===2),'module headings sharing a file keep separate stable rows');
   await page.click('[data-course-content-open="courses/Discrete Structures/modules.md#unit-two"]');
   await h.waitText('Course modules');
   await page.waitForFunction(()=>document.querySelector('[data-file-viewer] [data-viewer-body]')?.contains(document.activeElement)&&document.activeElement.textContent==='Unit two');
   check(true,'second module opens its matching heading in the existing viewer');
   await page.waitForFunction(()=>window.__calls.some(([cmd,a])=>cmd==='file_view'&&a.path==='courses/Discrete Structures/modules.md'));
   check(await page.evaluate(()=>window.__calls.some(([cmd,a])=>cmd==='lms_course_content'&&a.course==='c1/101'&&a.space==='school')),'source browser uses selected course and permitted space');
   await h.shot('preview');
  }
 },
 {
  name:'lms-revision-cancel',sizes:[[1100,720],[640,480]],mock:{settings:SETTINGS,threads:{},lms:{list:[connection],step:3000,courses:[course,{...course,id:'102',name:'Calculus II'},...Array.from({length:50},(_,i)=>({...course,id:String(200+i),name:`Past course ${i+1}`,term:'Spring 2025',current:false}))]},courseAccess:{school:{'c1/101':ALL}}},
  async run(page,h){
   await sites(page);await page.click('[data-sites-import]');await page.click('[data-existing-site="c1"]');await page.waitForSelector('[data-course="101"]');
   check(await page.$eval('[data-course="101"] input',e=>e.checked),'already imported courses retain selection');
   await page.click('[data-past-courses] summary');
   const bounds=await page.evaluate(()=>{const d=document.querySelector('[data-course-import]').getBoundingClientRect();const p=document.querySelector('[data-past-courses] > div').getBoundingClientRect();const c=document.querySelector('[data-past-courses] .ui-check-box').getBoundingClientRect();const first=document.querySelector('[data-past-courses] [data-course]').getBoundingClientRect();const body=document.querySelector('[data-course-import] [data-wizard-body]').getBoundingClientRect();return {height:d.height,past:p.height,check:c.width,firstBottom:first.bottom,bodyBottom:body.bottom,viewport:innerHeight}});
   check(bounds.height<bounds.viewport&&bounds.past<=194&&bounds.check>=12&&bounds.check<=18&&bounds.firstBottom<=bounds.bodyBottom+1,'past courses stay bounded and selection controls stay compact',JSON.stringify(bounds));
   await h.shot('selection');
   await page.click('[data-step-next]');await page.click('[data-step-next]');await page.waitForSelector('[data-import-start]');await page.click('[data-import-start]');await page.waitForSelector('[data-import-cancel]');
   await h.shot('progress');
   await page.click('[data-import-close]');await page.waitForFunction(()=>!document.querySelector('[data-course-import]'));await page.waitForSelector('[data-settings-import-cancel]');
   check(await page.$('[data-testid="settings-tab-appearance"]')!==null,'background import leaves Settings usable');
   await page.$eval('[data-settings-import-cancel]',e=>{e.scrollIntoView({block:'center'});e.focus()});
   await h.idle();
   const hit=await page.$eval('[data-settings-import-cancel]',e=>{const r=e.getBoundingClientRect();const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {reachable:hit===e||e.contains(hit),target:e.outerHTML,hit:hit?.outerHTML.slice(0,300),rect:r.toJSON(),disabled:e.disabled}});
   check(hit.reachable,'Settings Stop control is reachable by pointer',JSON.stringify(hit));
   await page.click('[data-settings-import-cancel]');
   await page.waitForFunction(()=>document.querySelector('[data-import-notice="done"]'));
   await page.waitForFunction(()=>window.__calls.some(([cmd,a])=>cmd==='lms_import_cancel'&&a.connection==='c1'));
   check(true,'Stop reaches native import cancellation');
   check(await page.evaluate(()=>!document.querySelector('[data-course-import-active]')),'cancelled import leaves active state');
   await h.shot('cancelled');
  }
 },
 {
  name:'lms-revision-partial',sizes:[[1100,720],[640,480]],mock:{settings:SETTINGS,threads:{},lms:{list:[connection],courses:[{...course,current:false,partial:true}]}},
  async run(page,h){
   await sites(page);await page.click('[data-sites-import]');await page.waitForSelector('[data-existing-site="c1"]');await page.click('[data-existing-site="c1"]');
   await page.waitForSelector('[data-course="101"] [data-course-partial]');
   check(await page.$eval('[data-course="101"] input',e=>e.checked),'partial past import is selected for resume');
   check((await page.$eval('[data-course="101"] [data-course-partial]',e=>e.textContent)).includes('Resume import'),'partial state has a concise Resume label');
   await page.click('[data-step-next]');await page.click('[data-step-next]');await page.waitForSelector('[data-import-start]');await page.click('[data-import-start]');
   await page.waitForFunction(()=>window.__calls.some(([cmd,a])=>cmd==='lms_import'&&a.connection==='c1'&&a.courseIds.join()==='101'));
   check(true,'resume uses the existing import command with the same course identifier');
   await h.shot('resume');
  }
 }

];
