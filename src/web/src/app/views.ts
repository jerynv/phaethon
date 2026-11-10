import {
  BookOpenIcon,
  CalendarDaysIcon,
  ChartNoAxesColumnIcon,
  LibraryBigIcon,
  MessageSquareTextIcon,
  type LucideIcon,
} from "lucide-react";
import type { View } from "./nav";

export type ViewKind = View["kind"];

export const VIEWS: readonly { kind: ViewKind; label: string; icon: LucideIcon; education: boolean }[] = [
  { kind: "chat", label: "Chat", icon: MessageSquareTextIcon, education: false },
  { kind: "study", label: "Study", icon: BookOpenIcon, education: true },
  { kind: "grades", label: "Grades", icon: ChartNoAxesColumnIcon, education: true },
  { kind: "plan", label: "Plan", icon: CalendarDaysIcon, education: true },
  { kind: "courses", label: "Courses", icon: LibraryBigIcon, education: true },
];

export function visibleViews(educationEnabled: boolean) {
  return VIEWS.filter((v) => educationEnabled || !v.education);
}

export function viewLabel(kind: ViewKind): string {
  return VIEWS.find((v) => v.kind === kind)?.label ?? "Chat";
}
