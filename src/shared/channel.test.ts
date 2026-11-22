import { describe, expect, it } from "vitest";
import { CHANNEL, IDENTITY, identityOf } from "./channel.ts";

describe("build channel", () => {
  it("a release keeps the names existing installs already use", () => {
    // Changing any of these would strand people's vault, app data or saved keys.
    expect(identityOf("release")).toEqual({
      productName: "Phaethon",
      appIdentifier: "io.github.jerynv.phaethon",
      vaultFolder: "Phaethon",
      keychainService: "phaethon",
    });
  });

  it("a dev build shares none of them", () => {
    const release = identityOf("release");
    const dev = identityOf("dev");
    for (const key of Object.keys(release) as (keyof typeof release)[]) expect(dev[key]).not.toBe(release[key]);
  });

  it("anything not built as a dev build is a release", () => {
    expect(CHANNEL).toBe("release");
    expect(IDENTITY).toEqual(identityOf("release"));
  });
});
