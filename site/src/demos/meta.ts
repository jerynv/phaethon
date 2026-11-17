import type { Size } from "./frame";

/** Each demo's design size and what it shows, for the page to reserve its box and describe it before the demo itself loads. */
export const meta: Record<"spaces" | "approve" | "models" | "vault", { size: Size; label: string }> = {
  spaces: {
    size: { width: 680, height: 440, compact: { below: 560, width: 358, height: 358 } },
    label: "Phaethon in a space called School. Asked to plan the week, the agent stops and asks to read shifts.md from the Work space, read only, with Allow once, Always allow and Don't allow. It's allowed once, and its plan fits study time around the shifts.",
  },
  approve: {
    size: { width: 680, height: 440, compact: { below: 560, width: 358, height: 358 } },
    label: "Phaethon's agent about to change week6.md. The card shows the change, three new lines for Monday, Wednesday and Friday, with Apply change and Don't allow. It's applied, and the thread notes that week6.md changed.",
  },
  models: {
    size: { width: 680, height: 440, compact: { below: 560, width: 358, height: 358 } },
    label: "Phaethon's model picker, open above the message box. Providers down the side: Anthropic, OpenAI, Ollama and Claude Code. Claude Opus 5.5 is selected; llama3.3, running on this computer through Ollama, is picked instead.",
  },
  vault: {
    size: { width: 680, height: 440, compact: { below: 560, width: 358, height: 358 } },
    label: "A vault open in Finder: MANUAL.md, and the folders memory, skills and spaces, with school and work inside spaces. people.md in memory is open beside it, as plain text: Dana Ruiz, TA for C241, office hours Thursday at 2 pm.",
  },
};
