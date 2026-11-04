import type { SVGProps } from "react";
import {
  Accessibility, ArrowDown, ArrowUp, AudioLines, Bot, Brain, Check, ChevronDown,
  ChevronLeft, ChevronRight, ChevronUp, CircleAlert, CircleCheck, Copy, Download,
  Ellipsis, File, FilePlus2, FileText, Folder, FolderOpen, FolderPlus, Image,
  ImageOff, Info, KeyRound, Link, LoaderCircle, LockKeyhole, Maximize2, Mic, Minus,
  Moon, PanelLeft, Paperclip, Pause, Pencil, Phone, Play, Plus, RotateCcw, Search,
  Settings2, ShieldCheck, Square, Sun, SunMoon, ThumbsDown, ThumbsUp, Trash2,
  TriangleAlert, UserRound, Video, Volume2, Wrench, X, BookOpen, type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";

import type { IconName } from "./names";

export type { IconName } from "./names";
export { ICON_NAMES } from "./names";

type IconProps = Omit<SVGProps<SVGSVGElement>, "children"> & {
  name: IconName;
  /** Give the icon a name only when it carries meaning on its own (no visible text beside it). */
  label?: string;
};

// Lucide is also used by T3 Code's Sidebar.tsx. Static imports keep the bundle
// limited to the application's icon set, while names remain stable for callers.
const ICONS: Record<IconName, LucideIcon> = {
  plus: Plus, close: X, check: Check, copy: Copy, edit: Pencil, retry: RotateCcw,
  more: Ellipsis, download: Download, search: Search, send: ArrowUp, stop: Square,
  attach: Paperclip, remove: Minus, trash: Trash2, play: Play, pause: Pause,
  "chevron-down": ChevronDown, "chevron-up": ChevronUp, "chevron-left": ChevronLeft,
  "chevron-right": ChevronRight, "arrow-down": ArrowDown,
  file: File, "file-text": FileText, "file-plus": FilePlus2, image: Image,
  "image-off": ImageOff, video: Video, audio: AudioLines, folder: Folder,
  "folder-plus": FolderPlus, book: BookOpen, thinking: Brain, tool: Wrench,
  agent: Bot, spinner: LoaderCircle, voice: Volume2, mic: Mic, phone: Phone,
  info: Info, warning: TriangleAlert, error: CircleAlert, success: CircleCheck,
  shield: ShieldCheck, lock: LockKeyhole, key: KeyRound, link: Link,
  "thumbs-up": ThumbsUp, "thumbs-down": ThumbsDown, settings: Settings2,
  appearance: SunMoon, accessibility: Accessibility, sidebar: PanelLeft,
  space: FolderOpen, user: UserRound, sun: Sun, moon: Moon,
  "window-minimize": Minus, "window-maximize": Square,
  "window-restore": Maximize2, "window-close": X,
};

/** Shared sizing and saved line-weight preferences apply to the Lucide family. */
export function Icon({ name, label, className, style, ...rest }: IconProps) {
  const Glyph = ICONS[name];
  return (
    <Glyph
      data-icon={name}
      className={cn("size-(--ph-icon-size) shrink-0", className)}
      style={{ strokeWidth: "var(--ph-icon-stroke)", ...style }}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true, focusable: false })}
      {...rest}
    />
  );
}
