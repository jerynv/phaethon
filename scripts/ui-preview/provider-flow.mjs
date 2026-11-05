// Provider dialogs open configuration; selecting the default is a separate action.
export const providerPopup = "[data-provider-popup]";

async function activate(page, selector, keyboard) {
  await page.waitForSelector(selector, { visible: true, timeout: 3000 });
  await page.$eval(selector, (button) => button.scrollIntoView({ block: "center" }));
  if (keyboard) {
    await page.focus(selector);
    await page.keyboard.press("Enter");
  } else await page.click(selector);
}

export async function openProviderConfiguration(page, id, { keyboard = false, catalog = false } = {}) {
  const manage = `[data-provider-configure="${id}"]`;
  if (!catalog && await page.$(manage)) await activate(page, manage, keyboard);
  else {
    await activate(page, "[data-provider-add]", keyboard);
    await page.waitForSelector('[data-provider-popup="catalog"]', { visible: true, timeout: 3000 });
    await activate(page, `[data-provider-catalog-select="${id}"]`, keyboard);
  }
  await page.waitForSelector(`${providerPopup} [data-provider-configuration="${id}"]`, { visible: true, timeout: 3000 });
}

export async function useProviderDefault(page, id, { keyboard = false } = {}) {
  const target = id.endsWith("-cli") ? `[data-backend="${id}"]` : `[data-provider-default="${id}"]`;
  await activate(page, `${providerPopup} ${target}`, keyboard);
}

export async function closeProviderPopup(page, { keyboard = false } = {}) {
  const modal = await page.$('[role="dialog"][data-provider-popup]');
  if (!modal) {
    // Existing CLI management is now inline. On narrow layouts, Back returns
    // to the account list; on desktop both list and detail remain available.
    const back = await page.$('[data-provider-detail] .provider-detail-back');
    if (back && await back.isVisible()) await back.click();
    return;
  }
  const dialog = modal;
  const buttons = await modal.$$('[data-slot="dialog-footer"] button');
  let button;
  for (const candidate of buttons) {
    if (await candidate.evaluate(node => ["Done", "Cancel"].includes(node.textContent.trim()))) button = candidate;
  }
  if (!button) throw new Error("Provider dialog has no Done or Cancel button");
  const name = await button.evaluate((node) => node.textContent.trim());
  if (name !== "Done" && name !== "Cancel") throw new Error(`Unexpected provider dialog close button: ${name}`);
  await button.evaluate((node) => node.scrollIntoView({ block: "center" }));
  if (keyboard) {
    await button.focus();
    await page.keyboard.press("Enter");
  } else await button.click();
  await page.waitForFunction((node) => !node.isConnected, { timeout: 3000 }, dialog);
}
