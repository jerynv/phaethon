import { host } from "../host.ts";
import { commands, Refusal } from "../rpc/registry.ts";

/**
 * System-owned dictation: the OS owns the microphone permission and the
 * recognition, and the text lands in the focused field; nothing is sent.
 * Only macOS has a way to start it from the app.
 */
export const NOT_HERE = "Use your operating system's dictation shortcut in the message field.";
export const DID_NOT_START = "Dictation did not start.";

export async function startDictation(platform: NodeJS.Platform = process.platform): Promise<null> {
  if (platform !== "darwin") throw new Refusal(NOT_HERE);
  if (!host().available) throw new Refusal(DID_NOT_START);
  try {
    await host().call({ op: "dictationStart" });
  } catch (e) {
    throw new Refusal(e instanceof Error && e.message ? e.message : DID_NOT_START);
  }
  return null;
}

commands({
  voice_dictation_start: () => startDictation(),
});
