import type { IconData } from "@/components/icon";
import { icons } from "@/components/icons";
import type { View } from "./store";

/**
 * A space's views, in order (⌥⌘1–6). Chat and Files are in every space; study
 * tools appear only in spaces that have them. `keepAlive` views stay mounted (hidden) after their first visit,
 * so switching back keeps their scroll, drafts and loaded data; a view with
 * global key handlers (Study's review session) must not be kept alive.
 */
export const VIEWS: { id: View; label: string; icon: IconData; edu: boolean; keepAlive: boolean }[] = [
  { id: "chat", label: "Chat", icon: icons.chat, edu: false, keepAlive: true },
  { id: "files", label: "Files", icon: icons.folder, edu: false, keepAlive: true },
  { id: "study", label: "Study", icon: icons.study, edu: true, keepAlive: false },
  { id: "grades", label: "Grades", icon: icons.grades, edu: true, keepAlive: true },
  { id: "plan", label: "Plan", icon: icons.plan, edu: true, keepAlive: true },
  { id: "courses", label: "Courses", icon: icons.courses, edu: true, keepAlive: false },
];
