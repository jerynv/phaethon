const check = (ok, message) => { if (!ok) throw new Error(message); };
export default [{
  name: "voice-dictation",
  mock: { threads: {}, platform: "mac" },
  async run(page, h) {
    await page.waitForSelector('[data-composer-input]');
    check(await page.evaluate(() => !window.__calls.some(([c]) => c === "voice_dictation_start")), "Dictation must never start on mount");
    await page.type('[data-composer-input]', 'Keep this draft');
    await h.click('[data-voice-input] button');
    await page.waitForFunction(() => window.__calls.some(([c]) => c === "voice_dictation_start"));
    const state = await page.evaluate(() => ({
      focus: document.activeElement?.matches('[data-composer-input]'),
      draft: document.querySelector('[data-composer-input]').value,
      sends: window.__calls.filter(([c]) => c === "agent_send").length,
    }));
    check(state.focus && state.draft === 'Keep this draft' && state.sends === 0, "Dictation edits the focused draft without auto-send");
    await page.evaluate(() => { window.__MOCK__.fail = { voice_dictation_start: 'Enable Dictation in System Settings' }; });
    await h.click('[data-voice-input] button');
    await h.waitText('Enable Dictation in System Settings');
    check(await page.$eval('[data-voice-input] button', el => !el.disabled), "Dictation failure must allow retry");
  },
}];
