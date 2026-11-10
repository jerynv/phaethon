import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, tempHome } from "../../../tests/harness.ts";
import { ensureVault, spaceDir } from "../core/vault.ts";
import { updateSettings } from "../settings/settings.ts";
import "../commands.ts";

const env = tempHome();
afterAll(() => env.cleanup());
beforeAll(() => ensureVault());
const meta = () => JSON.parse(fs.readFileSync(path.join(spaceDir("school"), ".phaethon/space.json"), "utf8"));

describe("space models", () => {
  it("saves Phaethon's model as a ref and lists it", async () => {
    await call("space_model_set", { space: "school", model: "claude-sonnet-5-5" });
    expect(await call("space_models_list")).toEqual({ school: meta().model });
    expect(await call("space_model_get", { space: "school" })).toBe(meta().model);
    await expect(call("space_model_set", { space: "school", model: "not a model!" })).rejects.toThrow("That isn’t a model Phaethon knows how to use.");
    await call("space_model_set", { space: "school", model: null });
    expect(meta().model).toBeUndefined();
  });

  it("saves a coding agent's model under cliModels and reads it back for that backend", async () => {
    await call("space_model_set", { space: "school", model: "codex:gpt-6.1-sol" });
    expect(meta().cliModels).toEqual({ codex: "gpt-6.1-sol" });
    updateSettings({ backend: "codex-cli" });
    expect(await call("space_models_list")).toEqual({ school: "codex:gpt-6.1-sol" });
    await call("space_model_set", { space: "school", model: null });
    expect(meta().cliModels).toBeUndefined();
    updateSettings({ backend: "phaethon" });
  });

  it("clears reasoning levels and prunes empty tables", async () => {
    fs.writeFileSync(path.join(spaceDir("school"), ".phaethon/space.json"), JSON.stringify({ cliReasoning: { claude: { $default: "high" } } }));
    expect(await call("space_reasoning_get", { space: "school", cli: "claude", model: null })).toBe("high");
    await call("space_reasoning_set", { space: "school", cli: "claude", model: null, effort: null });
    expect(meta().cliReasoning).toBeUndefined();
    await expect(call("space_reasoning_set", { space: "school", cli: "nope", model: null, effort: null })).rejects.toThrow("Unknown assistant.");
  });
});
