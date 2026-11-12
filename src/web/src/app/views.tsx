import { CalendarDaysIcon, ChartNoAxesColumnIcon, MessageSquareIcon } from "lucide-react";
import { Cards, GraduationCap } from "@phosphor-icons/react";
import type { ComponentType } from "react";
import type { View } from "./store";

type IconProps = { className?: string };
const CardsIcon = ({ className }: IconProps) => <Cards className={className} weight="regular" />;
const CapIcon = ({ className }: IconProps) => <GraduationCap className={className} weight="regular" />;

/** A space's views, in order (⌥⌘1–5). Study tools appear only in spaces that have them. */
export const VIEWS: { id: View; label: string; icon: ComponentType<IconProps>; edu: boolean }[] = [
  { id: "chat", label: "Chat", icon: ({ className }) => <MessageSquareIcon className={className} strokeWidth={1.75} />, edu: false },
  { id: "study", label: "Study", icon: CardsIcon, edu: true },
  { id: "grades", label: "Grades", icon: ({ className }) => <ChartNoAxesColumnIcon className={className} strokeWidth={1.75} />, edu: true },
  { id: "plan", label: "Plan", icon: ({ className }) => <CalendarDaysIcon className={className} strokeWidth={1.75} />, edu: true },
  { id: "courses", label: "Courses", icon: CapIcon, edu: true },
];
