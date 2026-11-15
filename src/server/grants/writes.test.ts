import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tempHome } from "../../../tests/harness.ts";
import { ensureVault } from "../core/vault.ts";
import { setSettings } from "../settings/settings.ts";
import { setWritesAllowed, spaceAllowsWrites, writePermissions } from "./writes.ts";

const env = tempHome();
beforeAll(() => ensureVault());
afterAll(() => env.cleanup());

describe("writing without asking", () => {
  it("is never allowed by a space name that matches an object method", () => {
    setSettings({ allowWrites: undefined });
    for (const name of ["constructor", "tostring", "hasownproperty", "__proto__"]) expect(spaceAllowsWrites(name), name).toBeUndefined();
    setWritesAllowed("constructor", null, "space", true);
    expect(spaceAllowsWrites("constructor")).toBeTypeOf("number");
    setWritesAllowed("constructor", null, "space", false);
    expect(spaceAllowsWrites("constructor")).toBeUndefined();
    expect(writePermissions("school").spaces).toEqual([]);
  });
});
