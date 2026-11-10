import { describe, expect, it } from "vitest";

import type { InstanceView } from "./api";
import { currentInstance, instanceStatus } from "./logic";

const view = (over: Partial<InstanceView> & { id: string; cli?: "claude" | "codex" | "gemini" }): InstanceView => ({
  config: { id: over.id, cli: over.cli ?? "claude", name: over.id, binary: "", args: [] },
  installed: true,
  loggedIn: null,
  account: null,
  plan: null,
  selected: false,
  managedHome: true,
  source: "managed",
  readOnly: false,
  ...over,
});

describe("instances", () => {
  it("uses the selected instance, else the built-in", () => {
    const list = [view({ id: "claude" }), view({ id: "claude-work" }), view({ id: "codex", cli: "codex" })];
    expect(currentInstance(list, "claude")?.config.id).toBe("claude");
    list[1].selected = true;
    expect(currentInstance(list, "claude")?.config.id).toBe("claude-work");
    expect(currentInstance(list, "gemini")).toBeUndefined();
  });
  it("says the status in words", () => {
    expect(instanceStatus(view({ id: "claude", loggedIn: true, account: "a@b.c", plan: "Max" })).text).toBe("Signed in as a@b.c · Max");
    expect(instanceStatus(view({ id: "claude", loggedIn: false })).tone).toBe("warning");
    expect(instanceStatus(view({ id: "claude", installed: false })).text).toBe("Not installed");
    expect(instanceStatus(view({ id: "gemini", cli: "gemini" })).text).toBe("Installed");
  });
});
