import { FilePdfIcon } from "@phosphor-icons/react";
import { FileCodeIcon, FileIcon as FileBlankIcon, FileImageIcon, FileSpreadsheetIcon, FileTextIcon, FileVideoIcon, FileAudioIcon, PresentationIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ViewKind } from "./kinds";

const CODE = /\.(js|mjs|cjs|jsx|ts|tsx|py|rb|rs|go|java|kt|swift|c|h|cpp|hpp|cs|php|sh|bash|zsh|sql|r|lua|json|jsonl|yaml|yml|toml|ini|xml|html|htm|css|tex|bib)$/i;

/** A file's kind from its name alone, for lists that haven't asked the core. */
export function kindOfName(name: string): ViewKind {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (ext === "pdf") return "pdf";
  if (["md", "markdown"].includes(ext)) return "markdown";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "heic"].includes(ext)) return "image";
  if (["doc", "docx", "odt", "rtf"].includes(ext)) return "docx";
  if (["xls", "xlsx", "csv", "ods"].includes(ext)) return "spreadsheet";
  if (["ppt", "pptx", "key", "odp"].includes(ext)) return "slides";
  if (["mp3", "wav", "m4a", "ogg", "flac"].includes(ext)) return "audio";
  if (["mp4", "mov", "webm", "mkv"].includes(ext)) return "video";
  if (ext === "tex") return "tex";
  if (ext === "txt" || CODE.test(name)) return "text";
  return "other";
}

/** The glyph for a file kind (docs/UI-REBUILD.md › Icons › File kinds). */
export function FileIcon({ kind, name, className }: { kind?: ViewKind; name?: string; className?: string }) {
  const k = kind ?? kindOfName(name ?? "");
  const cls = cn("size-4 shrink-0 text-muted-foreground", className);
  const code = k === "tex" || (k === "text" && !!name && CODE.test(name));
  switch (k) {
    case "pdf":
      return <FilePdfIcon className={cls} weight="regular" aria-hidden />;
    case "image":
      return <FileImageIcon className={cls} strokeWidth={1.75} aria-hidden />;
    case "spreadsheet":
      return <FileSpreadsheetIcon className={cls} strokeWidth={1.75} aria-hidden />;
    case "slides":
      return <PresentationIcon className={cls} strokeWidth={1.75} aria-hidden />;
    case "audio":
      return <FileAudioIcon className={cls} strokeWidth={1.75} aria-hidden />;
    case "video":
      return <FileVideoIcon className={cls} strokeWidth={1.75} aria-hidden />;
    case "markdown":
    case "docx":
      return <FileTextIcon className={cls} strokeWidth={1.75} aria-hidden />;
    case "text":
    case "tex":
      return code ? <FileCodeIcon className={cls} strokeWidth={1.75} aria-hidden /> : <FileTextIcon className={cls} strokeWidth={1.75} aria-hidden />;
    default:
      return <FileBlankIcon className={cls} strokeWidth={1.75} aria-hidden />;
  }
}
