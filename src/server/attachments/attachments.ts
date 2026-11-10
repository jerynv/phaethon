// STUB: owned by storage
import fs from "node:fs";
import path from "node:path";
import { spaceDir } from "../core/vault.ts";
import { ATTACHMENT_TYPE, LEGACY_ATTACHMENT_TYPE, type Block, type Role } from "../core/thread.ts";

export type Upload = { name: string; mediaType: string; data: string };

/** Saves uploads into `<space>/attachments/` and returns reference blocks. */
export function saveUploads(space: string, uploads: Upload[]): Block[] {
  const dir = path.join(spaceDir(space), "attachments");
  return uploads.map((u, i) => {
    fs.mkdirSync(dir, { recursive: true });
    const name = `${Date.now()}-${i}-${path.basename(u.name)}`;
    fs.writeFileSync(path.join(dir, name), Buffer.from(u.data, "base64"));
    return { type: ATTACHMENT_TYPE, path: `attachments/${name}`, media_type: u.mediaType, name: u.name };
  });
}

/** Inlines attachment references as image/document blocks for one request. Same length and order as given. */
export function expandForProvider(space: string, msgs: { role: Role; content: Block[] }[], sees: { images: boolean; pdf: boolean }): { role: Role; content: Block[] }[] {
  const root = spaceDir(space);
  return msgs.map((m) => ({
    role: m.role,
    content: m.content.map((b) => {
      if (b.type !== ATTACHMENT_TYPE && b.type !== LEGACY_ATTACHMENT_TYPE) return b;
      const name = String(b.name ?? "");
      const media = String(b.media_type ?? "");
      let data: Buffer;
      try {
        data = fs.readFileSync(path.join(root, String(b.path ?? "")));
      } catch {
        return { type: "text", text: `[The attached file ${name} is no longer in this space.]` };
      }
      if (media.startsWith("image/")) return { type: "image", source: { type: "base64", media_type: media, data: data.toString("base64") } };
      if (media === "application/pdf") {
        if (sees.pdf) return { type: "document", title: name, source: { type: "base64", media_type: "application/pdf", data: data.toString("base64") } };
        return { type: "text", text: `[The attached PDF ${name} couldn’t be read as text.]` };
      }
      return { type: "document", title: name, source: { type: "text", media_type: "text/plain", data: data.toString("utf8") } };
    }),
  }));
}

export function removeAttachments(_space: string, _paths: string[]): void {}
