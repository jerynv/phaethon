import { ChevronDown, ChevronRight, FileText, Folder } from "lucide-react";
import type { ReactNode } from "react";
import { Stage } from "../stage/kit/stage";
import { Bar, Window } from "../stage/kit/window";
import { meta } from "./meta";
import "./demos.css";

// The vault. A still: the vault open in a Finder-style list, plain folders
// and Markdown files, one memory file selected; beside it, that file opened,
// a few lines of ordinary text. The point is that what Phaethon remembers is
// a file you can read.
//
// Real strings: the file and folder names, the open file's lines.

type Item = { name: string; depth: number; kind: "folder" | "file"; open?: boolean; selected?: boolean; date: number };
const ITEMS: Item[] = [
  { name: "MANUAL.md", depth: 0, kind: "file", date: 64 },
  { name: "memory", depth: 0, kind: "folder", open: true, date: 58 },
  { name: "people.md", depth: 1, kind: "file", selected: true, date: 52 },
  { name: "school.md", depth: 1, kind: "file", date: 60 },
  { name: "skills", depth: 0, kind: "folder", open: true, date: 56 },
  { name: "study-guide.md", depth: 1, kind: "file", date: 50 },
  { name: "spaces", depth: 0, kind: "folder", open: true, date: 62 },
  { name: "home", depth: 1, kind: "folder", date: 48 },
  { name: "school", depth: 1, kind: "folder", date: 54 },
  { name: "work", depth: 1, kind: "folder", date: 58 },
];
const FILE = ["# People", "Dana Ruiz, C241 TA", "Office hours Thu 2 pm", "Prefers email"];

const vaultSize = meta.vault.size;

function Glyph({ item }: { item: Item }): ReactNode {
  const ic = { size: 16, strokeWidth: 1.4 };
  return item.kind === "folder" ? <Folder {...ic} className="dm-vault__folder" /> : <FileText {...ic} className="dm-vault__file" />;
}

export default function VaultDemo() {
  return (
    <Stage {...vaultSize} fill className="ph-look dm-vault">
      {(_s, _rect, layout) => (
        <>
          <Window className="dm-win" title="default">
            <div className="dm-vault__list">
              <div className="dm-vault__cols">
                <span>Name</span>
                {layout === "wide" ? <span>Date modified</span> : null}
              </div>
              {ITEMS.filter((it) => layout === "wide" || it.name !== "study-guide.md").map((it) => (
                <div key={`${it.depth}${it.name}`} className="dm-vault__row" data-on={it.selected || undefined} style={{ paddingLeft: 10 + it.depth * 20 }}>
                  <span className="dm-vault__disclosure">{it.kind === "folder" ? it.open && (layout === "wide" || it.name !== "skills") ? <ChevronDown size={12} strokeWidth={2} /> : <ChevronRight size={12} strokeWidth={2} /> : null}</span>
                  <Glyph item={it} />
                  <span className="dm-vault__name">{it.name}</span>
                  {layout === "wide" ? <Bar w={it.date} h={6} r={3} tone={it.selected ? 3 : 2} /> : null}
                </div>
              ))}
            </div>
          </Window>
          <div className="dm-note">
            <div className="dm-note__title">people.md</div>
            <div className="dm-note__body">
              {FILE.map((l, i) => (
                <div key={i} className={i === 0 ? "dm-note__h" : undefined}>
                  {l}
                </div>
              ))}
              {[120, 150, 96].map((w) => (
                <Bar key={w} w={w} h={6} r={3} tone={2} />
              ))}
            </div>
          </div>
        </>
      )}
    </Stage>
  );
}
