// Council B3/B4: scaled typography, compact painted marks with real hit room, forced-colour state.
import { SETTINGS, check } from '../audit-fixtures.mjs';
const ALL=['overview','syllabus','assignments','announcements','files','grades'];
const settings={...SETTINGS,appearance:{tokens:{'--ph-target-size':44}}};
const course={id:'101',name:'Discrete Structures',code:'CSCI-C 241',term:'Fall 2026',current:true};
const connection={id:'c1',kind:'canvas',address:'https://iu.instructure.com',schoolName:'Indiana University',signedIn:true,courses:['101'],lastSync:Date.UTC(2026,9,9,18)};
async function sites(page){
 await page.waitForSelector('[data-composer-input]');
 await page.keyboard.down('Meta');await page.keyboard.press(',');await page.keyboard.up('Meta');
 await page.waitForSelector('[data-testid="settings-tab-courses"]');await page.click('[data-testid="settings-tab-courses"]');
 await page.waitForSelector('[data-course-navigator]');
}
const fixture={settings,threads:{},lms:{list:[connection],courses:[course]},courseAccess:{school:{'c1/101':ALL}}};
export default [
 {
  name:'lms-review-type-and-hit',sizes:[[1100,720],[640,480]],mock:fixture,
  async run(page,h){
   await sites(page);await page.click('[data-course-select="c1/101"]');await page.waitForSelector('[data-access-grid]');
   const grid=await page.$eval('[data-access-row="work"] [data-access-part="overview"]',input=>{
    input.scrollIntoView({block:'center',inline:'center'});const box=input.getBoundingClientRect();const target=input.closest('.ui-check').getBoundingClientRect();const floor=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ph-target-min'));
    const x=box.x-6,y=box.y+box.height/2;
    return {paint:box.width,targetWidth:target.width,targetHeight:target.height,floor,x,y,expandedHit:document.elementFromPoint(x,y)===input};
   });
   check(grid.paint<=18&&grid.targetWidth>=grid.floor&&grid.targetHeight>=grid.floor&&grid.expandedHit,'grid keeps compact paint and a real transparent minimum target',JSON.stringify(grid));
   await page.mouse.click(grid.x,grid.y);
   await page.waitForFunction(()=>window.__calls.some(([cmd,a])=>cmd==='course_access_set'&&a.space==='work'&&a.parts.includes('overview')));
   check(true,'clicking outside the painted checkbox still changes its own permission');
   await h.shot('grid-hit');
   await page.click('[data-course-back]');await page.click('[data-sites-import]');await page.waitForSelector('[data-existing-site="c1"]');await page.click('[data-existing-site="c1"]');await page.waitForSelector('[data-course="101"]');
   await h.idle();
   const metrics=await page.evaluate(()=>{
    const root=getComputedStyle(document.documentElement);const scale=Number(root.getPropertyValue('--ph-text-scale'))||1;
    const title=document.querySelector('[data-course-import] [data-step-title]');const imported=document.querySelector('[data-course-imported]');const label=document.querySelector('[data-course="101"]');const target=label.querySelector('.ui-check');const rect=document.querySelector('[data-course-import]').getBoundingClientRect();const footer=document.querySelector('[data-course-import] [data-wizard-footer]').getBoundingClientRect();
    return {scale,title:parseFloat(getComputedStyle(title).fontSize),meta:parseFloat(getComputedStyle(imported).fontSize),label:label.getBoundingClientRect().height,target:target.getBoundingClientRect().height,floor:parseFloat(root.getPropertyValue('--ph-target-min')),top:rect.top,bottom:rect.bottom,footerBottom:footer.bottom,viewport:innerHeight};
   });
   check(metrics.title>=19*metrics.scale-0.5&&metrics.meta>=11*metrics.scale-0.5,'wizard title and imported metadata follow the saved text scale',JSON.stringify(metrics));
   check(metrics.label>=metrics.floor&&metrics.target>=metrics.floor,'course labels retain larger click targets',JSON.stringify(metrics));
   check(metrics.top>=0&&metrics.bottom<=metrics.viewport+1&&metrics.footerBottom<=metrics.viewport+1,'scaled wizard keeps its task footer inside the viewport',JSON.stringify(metrics));
   await h.shot('scaled-course');
  }
 },
 {
  name:'lms-review-kind-contrast',sizes:[[1100,720],[640,480]],mock:{settings,threads:{},lms:{list:[]}},
  async run(page,h){
   await sites(page);await page.click('[data-sites-import]');await page.waitForSelector('[data-kind="canvas"]');await page.click('[data-kind="canvas"]');
   const state=await page.$eval('[data-kind="canvas"]',choice=>{
    const indicator=choice.querySelector('.lms-site-selected');const rect=indicator?.getBoundingClientRect();const style=indicator&&getComputedStyle(indicator);const root=getComputedStyle(document.documentElement);const title=document.querySelector('[data-step-title]');
    return {checked:choice.getAttribute('aria-checked'),forced:matchMedia('(forced-colors: active)').matches,indicatorWidth:rect?.width,indicatorHeight:rect?.height,indicatorOpacity:style?.opacity,indicatorColor:style?.color,title:parseFloat(getComputedStyle(title).fontSize),scale:Number(root.getPropertyValue('--ph-text-scale'))||1};
   });
   check(state.checked==='true'&&state.indicatorWidth>0&&state.indicatorHeight>0&&state.indicatorOpacity!=='0','chosen site has a visible check independent of its background and focus ring',JSON.stringify(state));
   check(state.title>=19*state.scale-0.5,'site-choice heading follows text scale',JSON.stringify(state));
   await h.shot('checked-kind');
  }
 },
 {
  name:'lms-review-view-context',sizes:[[1100,720],[640,480]],mock:{...fixture,courseAccess:{school:{},work:{'c1/101':ALL}}},
  async run(page,h){
   await sites(page);await page.click('[data-course-select="c1/101"]');await page.click('[data-browse-course]');await page.waitForSelector('[data-course-content-open]');
   const context=await page.$eval('[data-course-view-context="work"]',e=>e.textContent);
   check(context.includes('Viewing as')&&context.includes('Work'),'vault-level source browser identifies its permission context',context);
   check(await page.evaluate(()=>window.__calls.some(([cmd,a])=>cmd==='lms_course_content'&&a.space==='work')),'context label matches the native content permission request');
   await h.shot('view-context');
   await page.click('[data-course-back]');await page.click('[data-course-overview-tab="sites"]');await page.waitForSelector('[data-site-synced]');
   check(await page.$$eval('[data-site-row] button :is(h1,h2,h3,h4,h5,h6,p,div)',els=>els.length===0),'connected-site button contains valid phrasing content');
   check((await page.$eval('[data-site-synced]',e=>e.getAttribute('datetime'))).startsWith('2026-10-09'),'connected site retains compact last-sync time');
   await page.click('[data-site-action="signout"]');await page.waitForSelector('[data-site-confirm]');
   check((await page.$eval('[data-site-confirm]',e=>e.textContent)).includes('Imported files stay available'),'disconnect confirms imported files are retained');
   await h.shot('disconnect');
  }
 }
];
