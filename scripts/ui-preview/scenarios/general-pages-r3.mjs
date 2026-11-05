import {check} from '../audit-fixtures.mjs';
import {GENERAL_WORKSPACE_MOCK} from '../general-workspace.mjs';

const shown='[data-space-pane][data-shown]';
const settings='[role="dialog"]:has([data-settings-header])';
async function close(page, selector) {
  await page.keyboard.press('Escape');
  await page.waitForFunction(selector=>!document.querySelector(selector),{timeout:5000},selector);
}
const fits=page=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1);
export default [{
  name:'general-pages-r3',
  mock:GENERAL_WORKSPACE_MOCK,
  async run(page,h) {
    await page.waitForSelector(`${shown} [data-composer-input]`);
    check(await page.$eval('[data-testid="open-settings"] svg',e=>e.classList.contains('lucide-settings')), 'Settings uses the actual cog glyph');
    check(await page.$eval('[data-testid="open-settings"] svg',e=>parseFloat(getComputedStyle(e).strokeWidth)<=1.5), 'default icon lines are restrained');
    const hierarchy=await page.$eval('[data-space-item="school"]',root=>({name:root.querySelector('[data-space-name]').getBoundingClientRect().right,chevron:root.querySelector('[data-space-expand]').getBoundingClientRect().left,newButtons:root.querySelectorAll('[data-new-conversation]').length}));
    check(hierarchy.chevron>hierarchy.name && hierarchy.newButtons===1,'folder header has trailing expander and a single quiet New action',JSON.stringify(hierarchy));
    await h.shot('chat');
    await h.click(`${shown} [data-model-picker]`);
    await page.waitForSelector('[data-model-picker-sidebar]');
    await page.waitForSelector('[data-model-list] [role="option"]');
    check(!await page.$('[data-model-menu] [role="menuitemradio"]'),'model picker is an inline combobox rather than a menu workaround');
    await h.shot('models');
    await close(page,'[data-model-menu]');

    await h.click('[data-sidebar-usage]');
    await page.waitForFunction(()=>document.querySelector('[data-usage-account="codex-system"] [data-usage-window="Weekly"]'));
    check(await page.$$eval('[data-usage-account]',rows=>rows.length===5),'usage shows every connection together');
    check(await page.$eval('[data-usage-account="codex-system"]',e=>e.textContent.includes('76')) && await page.$eval('[data-usage-account="codex"]',e=>e.textContent.includes('0%')),'separate System and managed accounts keep their real weekly usage');
    await h.shot('usage');
    await close(page,'[data-usage-dialog]');

    await h.click('[data-testid="open-settings"]');
    await page.waitForSelector('[data-agent-instances]');
    check(await page.$$eval('[data-settings-group] h4',headings=>!headings.some(e=>e.textContent==='API providers')),'empty API group is omitted');
    check(await page.$$eval('[data-provider-add]',buttons=>buttons.length===1) && !await page.$('[data-agent-instance-add]'),'provider settings has one Add connection entry');
    check(await page.$$eval('.provider-instance-row',rows=>rows.every(e=>getComputedStyle(e).boxShadow==='none' && parseFloat(getComputedStyle(e).fontWeight)<=400)),'provider rows avoid shadows and heavy text');
    await h.shot('providers');
    await h.click('[data-provider-add]');
    await page.waitForSelector('[data-provider-catalog]');
    await h.shot('add-connection');
    await close(page,'[data-provider-catalog]');
    for(const section of ['appearance','accessibility','spaces','courses','about']) {
      await h.click(`[data-testid="settings-tab-${section}"]`);
      await page.waitForFunction(section=>document.querySelector(`[data-testid="settings-tab-${section}"]`)?.getAttribute('data-state')==='active',{},section);
      if(section==='courses') await page.waitForSelector('[data-course-navigator]');
      check(await fits(page),`${section} keeps the page within its window`);
      await h.shot(section);
      if(section==='courses') {
        await h.click('[data-course-overview-tab="sites"]');
        check(await page.$$eval('[data-site-row]',rows=>rows.length===3),'connected sites share one bounded collection');
        await h.shot('connected-sites');
      }
    }
    await close(page,settings);
    for(const view of ['study','grades','plan']) {
      await h.click(`#spaces-sidebar:not([hidden]) [data-view-tab="${view}"]`);
      await page.waitForFunction(view=>document.querySelector(`#spaces-sidebar [data-view-tab="${view}"]`)?.getAttribute('aria-selected')==='true',{},view);
      check(await fits(page),`${view} keeps its general page within the window`);
      await h.shot(view);
    }
  },
}];
