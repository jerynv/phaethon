import { CalendarDots, Cards, ChartLineUp, ChatsTeardrop, GraduationCap } from "@phosphor-icons/react";
import type { ComponentType } from "react";
import type { View } from "./store";

type IconProps = { className?: string };

/**
 * A space's views, in order (⌥⌘1–5). Study tools appear only in spaces that
 * have them. `keepAlive` views stay mounted (hidden) after their first visit,
 * so switching back keeps their scroll, drafts and loaded data; a view with
 * global key handlers (Study's review session) must not be kept alive.
 */
export const VIEWS: { id: View; label: string; icon: ComponentType<IconProps>; edu: boolean; keepAlive: boolean }[] = [
  { id: "chat", label: "Chat", icon: ChatsTeardrop, edu: false, keepAlive: true },
  { id: "study", label: "Study", icon: Cards, edu: true, keepAlive: false },
  { id: "grades", label: "Grades", icon: ChartLineUp, edu: true, keepAlive: true },
  { id: "plan", label: "Plan", icon: CalendarDots, edu: true, keepAlive: true },
  { id: "courses", label: "Courses", icon: GraduationCap, edu: true, keepAlive: false },
];
