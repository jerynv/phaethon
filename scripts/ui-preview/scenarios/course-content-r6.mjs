import { SETTINGS, check } from '../audit-fixtures.mjs';
const parts=['overview','syllabus','assignments','announcements','files','grades'];
const folder='courses/Discrete Structures';
const entries=[
 {path:`${folder}/modules.md`,title:'Unit one',kind:'module',anchor:'unit',headingIndex:0},
 {path:`${folder}/modules.md`,title:'Unit two',kind:'module',anchor:'unit',headingIndex:1},
 ...Array.from({length:120},(_,i)=>({path:`${folder}/files/Lecture ${String(i+1).padStart(3,'0')}.md`,title:`Lecture ${String(i+1).padStart(3,'0')}`,kind:'file',bytes:2048+i})),
];
const mock={settings:SETTINGS,threads:{},lms:{list:[{id:'c1',kind:'canvas',address:'https://example.instructure.com',signedIn:true,courses:['101']}],courses:[{id:'101',name:'Discrete Structures',code:'C241',current:true}]},courseAccess:{school:{'c1/101':parts}},lmsContent:{'c1/101':entries},files:{[`${folder}/files/Lecture 120.md`]:{kind:'markdown',text:'# Final lecture\n\nThe last source is reachable.'},[`${folder}/modules.md`]:{kind:'markdown',text:'# Modules\n\n## Unit\n\nFirst unit\n\n## Unit\n\nSecond unit'}}};
async function browse(page,h){
 await page.waitForSelector('[data-composer-input]');
 await page.keyboard.down('Meta');await page.keyboard.press(',');await page.keyboard.up('Meta');
 await page.waitForSelector('[data-testid="settings-tab-courses"]');await h.click('[data-testid="settings-tab-courses"]');
 await page.waitForSelector('[data-course-select="c1/101"]');await h.click('[data-course-select="c1/101"]');await h.click('[data-browse-course]');
}
export default [
 {name:'course-content-r6',sizes:[[1100,720],[640,480]],sizesRequired:true,mock,async run(page,h){
  await browse(page,h);await page.waitForSelector('[data-course-content-open]');
  check(await page.$$eval('[data-course-content-open]',rows=>rows.length)===50,'large course index renders only the current page');
  check(!(await page.$eval('[data-course-content-list]',el=>el.innerText)).includes('courses/Discrete Structures'),'rows show names and useful metadata without a repeated path subtitle');
  check((await page.$eval('[data-course-content-count]',el=>el.textContent)).includes('122'),'the complete source count remains visible');
  const bounds=await page.evaluate(()=>{const panel=document.querySelector('[role="tabpanel"]:not([hidden])').getBoundingClientRect();const footer=document.querySelector('.course-content-footer').getBoundingClientRect();return {bottom:footer.bottom,panelBottom:panel.bottom};});
  check(bounds.bottom<=bounds.panelBottom+1,'paging and refresh remain visible without scrolling Settings',JSON.stringify(bounds));
  await h.shot('browser');
  await h.click('[aria-label="Next content page"]');
  check((await page.$eval('[data-course-content-count]',el=>el.textContent)).startsWith('51–100'),'next page reaches later imported content');
  await page.type('[aria-label="Search course content"]','lecture 120');
  await page.waitForFunction(()=>document.querySelectorAll('[data-course-content-open]').length===1);
  check(await page.$eval('[data-course-content-open]',el=>el.textContent.includes('Lecture 120')),'multiword search reaches a file beyond the rendered page');
  await h.click('[data-course-content-open]');await page.waitForFunction(()=>document.querySelector('[data-file-viewer]')?.textContent.includes('The last source is reachable.'));
  check(await page.evaluate(path=>window.__calls.some(([cmd,args])=>cmd==='file_view'&&args.space==='school'&&args.path===path),`${folder}/files/Lecture 120.md`),'opening a late search result retains the authorized space and exact original path');
  await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('[data-file-viewer]'));
  await page.$eval('[aria-label="Search course content"]',el=>{el.focus();el.select()});await page.keyboard.press('Backspace');
  await h.click('[aria-label="Course content type"]');await page.keyboard.press('Home');await page.keyboard.press('ArrowDown');await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
  await page.waitForFunction(()=>document.querySelectorAll('[data-course-content-open]').length===2);
  check(!await page.$('[aria-label="Next content page"]'),'type filtering resets page and removes unneeded pagination');
  const modules=await page.$$('[data-course-content-open]');await modules[1].click();
  await page.waitForFunction(()=>document.querySelectorAll('[data-file-viewer] [data-viewer-markdown] [data-md-depth="2"]')[1]===document.activeElement);
  check(true,'duplicate module anchors retain their actual heading ordinal');
  await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('[data-file-viewer]'));
  await page.type('[aria-label="Search course content"]','no source matches');
  await page.waitForFunction(()=>document.querySelector('[data-course-content-list]')?.textContent.includes('No matching content'));
  await h.shot('empty');
 }},
 {name:'course-content-r6-retry',sizes:[[1100,720]],mock:{...mock,fail:{lms_course_content:'Course index could not be read.'}},async run(page,h){
  await browse(page,h);await page.waitForFunction(()=>document.querySelector('[data-course-content] [role="alert"]')?.textContent.includes('Course index could not be read.'));
  check(!await page.$('[data-course-content-open]'),'load failure does not show stale source rows');
  await page.evaluate(()=>{delete window.__MOCK__.fail.lms_course_content;});
  const retry=await page.evaluateHandle(()=>[...document.querySelectorAll('[data-course-content] button')].find(el=>el.textContent==='Try again'));
  await retry.click();await page.waitForSelector('[data-course-content-open]');
  check(await page.$$eval('[data-course-content-open]',rows=>rows.length)===50,'retry recovers the actual index without leaving the course');
  await h.shot('recovered');
 }},
];
