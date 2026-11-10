import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { tempHome } from "../../../tests/harness.ts";
import { appFiles, ensureVault, vaultRoot } from "../core/vault.ts";
import { alert, fromMetadata, keepAt, knownSees, modelSees, remember, resetKnown, sees, sightForSpace } from "./sight.ts";
import type { Sight } from "./types.ts";

const env = tempHome();
afterAll(() => env.cleanup());
beforeAll(() => ensureVault());
beforeEach(() => resetKnown());

describe("sight", () => {
  it("models_are_known_to_see_known_not_to_or_unknown", () => {
    const yes: [string, string][] = [
      ["anthropic", "claude-opus-5-5"], ["anthropic", "claude-3-5-haiku-latest"], ["openai", "gpt-4o-mini"], ["openai", "gpt-5"], ["openai", "o3"], ["openai", "o4-mini"],
      ["openrouter", "google/gemini-2.5-pro"], ["openrouter", "anthropic/claude-sonnet-4.5"], ["openrouter", "qwen/qwen2.5-vl-72b-instruct"], ["ollama", "llama3.2-vision:11b"],
      ["ollama", "llava:13b"], ["ollama", "gemma3:12b"], ["mistral", "pixtral-large-latest"], ["groq", "meta-llama/llama-4-scout-17b-16e-instruct"], ["xai", "grok-4"],
    ];
    for (const [p, m] of yes) expect(modelSees(p, m), `${p} ${m}`).toBe("yes");
    const no: [string, string][] = [
      ["openai", "gpt-3.5-turbo"], ["openai", "gpt-4"], ["openai", "o3-mini"], ["openai", "o1-mini"], ["deepseek", "deepseek-chat"], ["openrouter", "deepseek/deepseek-r1"],
      ["anthropic", "claude-2.1"], ["mistral", "codestral-latest"],
    ];
    for (const [p, m] of no) expect(modelSees(p, m), `${p} ${m}`).toBe("no");
    const unknown: [string, string][] = [["ollama", "llama3.1:8b"], ["custom", "my-model"], ["together", "Qwen/Qwen2.5-72B-Instruct-Turbo"], ["groq", "llama-3.3-70b-versatile"]];
    for (const [p, m] of unknown) expect(modelSees(p, m), `${p} ${m}`).toBe("unknown");
  });

  it("a_providers_list_says_what_its_models_take_in", () => {
    const or = (inputs: unknown) => ({ id: "x/y", architecture: { modality: "text->text", input_modalities: inputs, output_modalities: ["text"], tokenizer: "Other" } });
    expect(fromMetadata(or(["text", "image", "file"]))).toBe("yes");
    expect(fromMetadata(or(["image", "text"]))).toBe("yes");
    expect(fromMetadata(or(["text"]))).toBe("no");
    expect(fromMetadata({ capabilities: ["completion", "vision"] })).toBe("yes");
    expect(fromMetadata({ capabilities: ["completion", "tools", "thinking"] })).toBe("no");
    expect(fromMetadata({ capabilities: ["image"] })).toBe("no");
    expect(fromMetadata({ capabilities: [] })).toBeNull();
    expect(fromMetadata({ id: "x" })).toBeNull();
  });

  it("what_a_list_said_comes_before_the_name_and_the_next_list_replaces_it", () => {
    const base = "http://127.0.0.1:1/v1/";
    expect(sees("ollama", base, "llama3.1:8b")).toBe("unknown");
    remember("ollama", base, [["llama3.1:8b", "no"], ["my-vlm:latest", "yes"]]);
    expect(sees("ollama", "http://127.0.0.1:1/v1", "llama3.1:8b")).toBe("no");
    expect(sees("ollama", base, "my-vlm:latest")).toBe("yes");
    expect(sees("ollama", "http://127.0.0.1:2/v1", "my-vlm:latest")).toBe("unknown");
    expect(sees("lmstudio", base, "my-vlm:latest")).toBe("unknown");
    expect(sees("ollama", base, "llava:13b")).toBe("yes");
    remember("ollama", base, [["llama3.1:8b", "no"]]);
    expect(sees("ollama", base, "my-vlm:latest")).toBe("unknown");
    remember("openrouter", "https://or.test/api/v1", [["acme/gemini-text-only", "no"]]);
    expect(sees("openrouter", "https://or.test/api/v1", "acme/gemini-text-only")).toBe("no");
    remember("ollama", base, []);
    expect(sees("ollama", base, "llama3.1:8b")).toBe("unknown");
  });

  it("what_lists_said_is_kept_on_disk_between_launches", () => {
    const file = path.join(env.home, "sight", "model-pictures.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"lists":{"openrouter https://kept.test/api/v1":{"acme/reader":"yes"}}}');
    keepAt(file);
    expect(knownSees("openrouter", "https://kept.test/api/v1", "acme/reader")).toBe("yes");
    remember("openrouter", "https://kept2.test/api/v1", [["acme/blind", "no"]]);
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(onDisk.lists["openrouter https://kept2.test/api/v1"]["acme/blind"]).toBe("no");
    expect(onDisk.lists["openrouter https://kept.test/api/v1"]["acme/reader"]).toBe("yes");
    // By default the app-data file is used.
    resetKnown();
    remember("ollama", "http://x", [["m", "yes"]]);
    expect(fs.existsSync(appFiles.modelPictures())).toBe(true);
  });

  it("the_alert_comes_only_when_the_course_leans_on_pictures_the_model_isnt_shown", () => {
    const sight = (s: Sight["sees"], shown: boolean): Sight => ({ sees: s, model: "gpt-3.5-turbo", shown });
    expect(alert(0, "this course", sight("no", false))).toBeNull();
    expect(alert(12, "this course", sight("yes", true))).toBeNull();
    let a = alert(12, "this course", sight("no", false))!;
    expect(a.kind).toBe("cantSee");
    expect(
      a.text.startsWith(
        "Your model can’t look at pictures, and 12 pages of this course are handwriting or diagrams. Questions from those pages may have mistakes or be missed. A model that can read pictures (for example",
      ),
    ).toBe(true);
    a = alert(1, "Test 1’s material", sight("unknown", false))!;
    expect(a.kind).toBe("unknown");
    expect(a.text.startsWith("Phaethon can’t tell whether your model (gpt-3.5-turbo) can look at pictures, and 1 page of Test 1’s material is handwriting or a diagram.")).toBe(true);
    expect(alert(3, "this course", { sees: "yes", model: "Gemini CLI", shown: false })!.kind).toBe("notShown");
  });

  it("a space's sight follows the backend and its model", () => {
    const settings = path.join(vaultRoot(), ".phaethon", "settings.json");
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, JSON.stringify({ backend: "claude-cli" }));
    expect(sightForSpace("school")).toEqual({ sees: "yes", model: "Claude Code", shown: true });
    fs.writeFileSync(settings, JSON.stringify({ backend: "gemini-cli" }));
    expect(sightForSpace("school")).toEqual({ sees: "yes", model: "Gemini CLI", shown: false });
    fs.writeFileSync(settings, JSON.stringify({ backend: "phaethon", provider: "openai", providerModels: { openai: "gpt-3.5-turbo" } }));
    expect(sightForSpace("school")).toEqual({ sees: "no", model: "gpt-3.5-turbo", shown: false });
    fs.writeFileSync(settings, JSON.stringify({ backend: "phaethon" }));
    expect(sightForSpace("school")).toEqual({ sees: "unknown", model: "Anthropic", shown: false });
    fs.mkdirSync(path.join(vaultRoot(), "spaces/school/.phaethon"), { recursive: true });
    fs.writeFileSync(path.join(vaultRoot(), "spaces/school/.phaethon/space.json"), JSON.stringify({ model: "anthropic:claude-opus-5-5" }));
    expect(sightForSpace("school")).toEqual({ sees: "yes", model: "claude-opus-5-5", shown: true });
  });
});
