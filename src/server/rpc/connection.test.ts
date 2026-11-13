import { describe, expect, it } from "vitest";
import { attach, type Link } from "./connection.ts";

describe("renderer request validation", () => {
  it("ignores non-object JSON frames and still answers the next ping", async () => {
    let receive!: (text: string) => void;
    const sent: string[] = [];
    const link: Link = {
      send: (text) => { sent.push(text); return true; },
      onMessage: (listener) => { receive = listener; },
      onClose: () => {},
    };
    attach(link);
    for (const text of ["null", "[]", "42", '"text"', "true", "not JSON"]) await receive(text);
    await receive('{"t":"ping"}');
    expect(sent.map((s) => JSON.parse(s))).toEqual([{ t: "pong" }]);
  });
});
