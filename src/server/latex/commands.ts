import fs from "node:fs";
import { commands, Refusal } from "../rpc/registry.ts";
import { spaceDir } from "../core/vault.ts";
import { cacheDir, cachedPdf, compileCached, engines, save, type Saved } from "./compile.ts";
import { NO_TEX, TIMEOUT_MS, choose, figureDocument, isDocument, kindName } from "./tex.ts";

/**
 * LaTeX documents and TikZ figures from a reply, compiled locally inside a
 * sandbox into PDFs the chat shows, and saved into the space on request.
 */
commands({
  latex_status: () => {
    const found = engines();
    const engine = choose(found, "");
    return {
      engine: engine ? kindName(engine.kind) : null,
      engines: found.map((e) => kindName(e.kind)),
      message: found.length === 0 ? NO_TEX : null,
    };
  },

  latex_compile: (args: { source: string; figure?: boolean }) => {
    return compileCached(cacheDir(), engines(), String(args.source ?? ""), Boolean(args.figure), TIMEOUT_MS);
  },

  latex_pdf: (args: { id: string }) => {
    const p = cachedPdf(cacheDir(), String(args.id ?? ""));
    if (!p) throw new Refusal("That PDF isn’t here any more. Compile the document again.");
    try {
      return fs.readFileSync(p);
    } catch (e) {
      throw new Refusal(`The PDF couldn’t be read: ${(e as Error).message}`);
    }
  },

  latex_save: async (args: { space: string; source: string; title: string; figure?: boolean }): Promise<Saved> => {
    const dir = spaceDir(args.space);
    const source = String(args.source ?? "");
    const figure = Boolean(args.figure);
    const cache = cacheDir();
    const outcome = await compileCached(cache, engines(), source, figure, TIMEOUT_MS);
    let pdf: Buffer | null = null;
    let note: string | null = null;
    if (outcome.status === "ok") {
      const p = cachedPdf(cache, outcome.id);
      try {
        pdf = p ? fs.readFileSync(p) : null;
      } catch {
        pdf = null;
      }
    } else {
      note = outcome.message;
    }
    // A figure is saved as a document that compiles on its own.
    const text = figure && !isDocument(source) ? figureDocument(source).doc : source;
    let saved: Saved;
    try {
      saved = save(dir, text, pdf, String(args.title ?? ""), figure);
    } catch (e) {
      throw new Refusal((e as Error).message);
    }
    if (saved.pdf === null && saved.note === null && note !== null) saved.note = `Only the source was saved: ${note}`;
    return saved;
  },
});
