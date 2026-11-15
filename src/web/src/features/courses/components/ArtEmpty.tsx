import { motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { ArtCanvas, type ArtPalette } from "@/components/art";
import { Card, CardContent, CardDescription, CardHeader, CardMedia, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * The empty state of Grades, Plan and Courses (docs/UI-REBUILD.md › Dialogs,
 * menus, empty states): an art strip, one line of title, one muted line and
 * one action, as a card centred in the page (after 2c35 and d1d3).
 */
export function ArtEmpty({
  palette,
  seed,
  title,
  description,
  children,
  className,
}: {
  palette: ArtPalette;
  seed?: string;
  title: ReactNode;
  description: ReactNode;
  /** The one action (and anything that replaces it, such as an inline form). */
  children?: ReactNode;
  className?: string;
}) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
      className={cn("mx-auto flex w-full max-w-md flex-col py-10", className)}
    >
      <Card>
        <CardMedia className="h-28">
          <ArtCanvas palette={palette} seed={seed ?? palette} weave className="absolute inset-0" />
        </CardMedia>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        {children ? <CardContent className="items-start">{children}</CardContent> : null}
      </Card>
    </motion.div>
  );
}
