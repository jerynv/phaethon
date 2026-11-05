import { SETTINGS, check, showSidebar } from '../audit-fixtures.mjs';

const sidebar = '#spaces-sidebar';
const toggle = 'button[aria-controls="spaces-sidebar"]';
const shown = '[data-space-pane][data-shown]';
const visibleSidebar = `${sidebar}:not([hidden])`;
const mock = { settings: SETTINGS, threads: {}, spaces: [{id:'school',name:'School',description:'',hue:240,educationEnabled:true},{id:'work',name:'Work',description:'',hue:50,educationEnabled:false}] };
const closed = page => page.waitForFunction(() => !document.getElementById('spaces-sidebar') || document.getElementById('spaces-sidebar').hidden);
async function open(page, h) {
  await h.click(toggle);
  await page.waitForSelector(visibleSidebar, { visible: true });
  await page.waitForFunction(() => document.getElementById('spaces-sidebar')?.contains(document.activeElement));
}
export default [
  { name:'sidebar-vic-r5-desktop', sizes:[[1100,720]], mock,
    async run(page,h) {
      await showSidebar(page);
      check(await page.$eval(sidebar,e=>e.classList.contains('ui-sidebar') && e.getAttribute('data-sidebar')==='sidebar'), 'actual Vic Sidebar owns the desktop rail');
      check(await page.$$eval(`${sidebar} [data-sidebar="header"], ${sidebar} [data-sidebar="content"], ${sidebar} [data-sidebar="footer"]`,e=>e.length===3), 'header scrolling content and footer are actual library parts');
      const before=await page.$eval('#main',e=>e.getBoundingClientRect().width);
      await h.click(toggle);await closed(page);
      const after=await page.$eval('#main',e=>e.getBoundingClientRect().width);
      check(after>before+150,'desktop collapse gives the conversation its full width');
      await h.click(toggle);await page.waitForSelector(visibleSidebar,{visible:true});
      await h.click('[data-space-expand="school"]');
      await h.click(toggle);await closed(page);await h.click(toggle);
      check(await page.$eval('#space-children-school',e=>e.hidden),'desktop hide/show preserves the folder expansion state');
      await page.focus('[data-space-id="school"]');await page.keyboard.press('ArrowDown');
      check(await page.evaluate(()=>document.activeElement?.getAttribute('data-space-id')==='work'),'host space keyboard navigation remains intact');
      await h.shot('desktop');
    } },
  { name:'sidebar-vic-r5-titlebar-settings', sizes:[[640,480]], sizesRequired:true, mock,
    async run(page,h) {
      check(!await page.$(visibleSidebar),'mobile sidebar starts closed');
      await h.click('header [data-testid="titlebar-settings"]');
      await page.waitForSelector('[data-settings-header]',{visible:true});
      check(!await page.$(visibleSidebar),'titlebar Settings opens directly without mounting the sidebar');
      check(await page.$$eval('[role="dialog"]',dialogs=>dialogs.length===1),'persistent Settings controller opens exactly one modal');
      await page.keyboard.press('Escape');
      await page.waitForFunction(()=>!document.querySelector('[data-settings-header]'));
      await page.waitForFunction(()=>document.activeElement?.matches('[data-testid="titlebar-settings"]'));
      check(true,'direct Settings close restores the titlebar opener');
    } },
  { name:'sidebar-vic-r5-overlay', sizes:[[640,480]], sizesRequired:true, mock,
    async run(page,h) {
      const before=await page.$eval('#main',e=>e.getBoundingClientRect().width);
      await open(page,h);
      check(await page.$eval(sidebar,e=>e.classList.contains('ui-sidebar-sheet') && e.getAttribute('role')==='dialog'),'Vic Base UI dialog owns the narrow sheet');
      check(!!await page.$('[data-sidebar-backdrop]') && !await page.$('[data-sidebar-scrim]'),'library backdrop replaces the app scrim');
      check(await page.$eval('#main',(e,b)=>e.inert && Math.abs(e.getBoundingClientRect().width-b)<1,before),'open sheet leaves conversation geometry stable and inert');
      for(let i=0;i<18;i++) await page.keyboard.press('Tab');
      check(await page.evaluate(()=>document.getElementById('spaces-sidebar')?.contains(document.activeElement)),'library traps keyboard focus in its open sheet');
      await page.keyboard.press('Escape');await closed(page);
      await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-controls')==='spaces-sidebar');
      check(await page.$eval('#main',e=>!e.inert),'Escape restores the opener and conversation');
      await open(page,h);await page.mouse.click(page.viewport().width-8,Math.floor(page.viewport().height/2));await closed(page);
      await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-controls')==='spaces-sidebar');
      check(true,'library outside press dismisses and restores focus');
      await open(page,h);await h.click(`${sidebar} button[aria-label="Close navigation"]`);await closed(page);
      check(true,'native library Close navigation action works');
      await page.waitForSelector(`${shown} [data-new-conversation]`,{visible:true});
      check(true,'conversation controls return to the compact header after sheet unmount');
    } },
  { name:'sidebar-vic-r5-nested-settings', sizes:[[640,480]], sizesRequired:true, mock,
    async run(page,h) {
      await open(page,h);await h.click(`${sidebar} button[aria-label="Settings"]`);
      await page.waitForSelector('[data-settings-header]',{visible:true});
      await page.keyboard.press('Tab');await page.keyboard.press('Tab');
      check(await page.$eval('[data-settings-header]',e=>e.closest('[role="dialog"]')?.contains(document.activeElement)),'nested Radix Settings retains focus inside the Vic modal sheet');
      await page.keyboard.press('Escape');
      await page.waitForFunction(()=>!document.querySelector('[data-settings-header]'));
      check(!!await page.$(visibleSidebar),'Escape dismisses nested Settings without dismissing its parent sheet');
      await page.waitForFunction(()=>document.getElementById('spaces-sidebar')?.contains(document.activeElement));
      check(true,'nested close restores focus to the sidebar Settings trigger');
      await h.shot('nested-return');
      await page.keyboard.press('Escape');await closed(page);
    } },
  { name:'sidebar-vic-r5-nested-menu-palette', sizes:[[640,480]], sizesRequired:true, mock,
    async run(page,h) {
      await open(page,h);await page.focus('[data-space-id="school"]');
      await page.keyboard.down('Shift');await page.keyboard.press('F10');await page.keyboard.up('Shift');
      await page.waitForSelector('[data-space-menu="school"]',{visible:true});
      check(await page.$eval('[data-space-menu="school"]',menu=>menu.contains(document.activeElement)),'space context menu retains keyboard focus above the sheet');
      await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('[data-space-menu="school"][data-state="open"]'));
      check(!!await page.$(visibleSidebar),'Escape dismisses the nested context menu without dismissing navigation');
      await page.waitForFunction(()=>document.getElementById('spaces-sidebar')?.contains(document.activeElement));
      await page.keyboard.down('Meta');await page.keyboard.press('k');await page.keyboard.up('Meta');
      await page.waitForSelector('[data-command-palette] dialog',{visible:true,timeout:4000});
      check(true,'global command palette remains available from the modal navigation sheet');
      await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('[data-command-palette]'));
      check(!!await page.$(visibleSidebar),'closing command palette preserves its parent navigation sheet');
      await page.keyboard.press('Escape');await closed(page);
    } },
  { name:'sidebar-vic-r5-hidden-unread', sizes:[[640,480]], sizesRequired:true, mock:{...mock,holdOpen:true,turn:[{kind:'text',delta:'Working on it.'}]},
    async run(page,h) {
      await h.send('Work on these notes');await page.waitForSelector(`${shown} button[aria-label="Stop reply"]`);
      await open(page,h);await h.click('[data-space-id="work"]');await page.waitForSelector('[data-space-pane="work"][data-shown]');await closed(page);
      await open(page,h);
      const childrenHidden=await page.$eval('#space-children-school',e=>e.hidden);
      if(!childrenHidden) await h.click('[data-space-expand="school"]');
      await page.keyboard.press('Escape');await closed(page);
      await page.evaluate(()=>{window.__liveTurn.send({kind:'end',sessionId:null});window.__liveTurn=null;});
      await page.waitForFunction(()=>!document.querySelector('[data-space-pane="school"] button[aria-label="Stop reply"]'));
      await open(page,h);await page.waitForSelector('[data-space-item="school"] [data-space-unread]');
      check(await page.$eval('#space-children-school',e=>e.hidden),'closed mobile unmount preserves collapsed folder and background completion');
      await h.click('[data-space-expand="school"]');await page.waitForSelector('[data-sidebar-conversations="school"] [data-thread-state="unread"]');
      await page.keyboard.press('Escape');await closed(page);await open(page,h);
      check(!!await page.$('[data-sidebar-conversations="school"] [data-thread-state="unread"]'),'repeated library unmounts preserve per-conversation unread state');
      await h.click('[data-sidebar-conversations="school"] [data-sidebar-thread="current"]');await closed(page);
      await open(page,h);
      check(!await page.$('[data-space-item="school"] [data-space-unread]'),'opening the actual conversation acknowledges the stored unread state');
      await h.shot('unread-acknowledged');
    } },
];
