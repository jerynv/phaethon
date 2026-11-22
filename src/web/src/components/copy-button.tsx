import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { toast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";

/** Icon button that copies `text` to the clipboard and confirms briefly with a check glyph. */
export function CopyButton({
  text,
  label = "Copy",
  className,
  variant = "ghost-muted",
  tooltip = true,
}: {
  text: string;
  label?: string;
  className?: string;
  variant?: "ghost-muted" | "outline";
  tooltip?: boolean;
}) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1500);
    return () => clearTimeout(t);
  }, [done]);

  const copy = () => {
    void navigator.clipboard.writeText(text).then(
      () => setDone(true),
      () => toast.error("Couldn’t copy", "Select the text and copy it instead."),
    );
  };

  const button = (
    <Button type="button" size="icon-xs" variant={variant} aria-label={done ? "Copied" : label} className={className} onClick={copy}>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={done ? "done" : "copy"}
          initial={{ scale: 0.5, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.5, opacity: 0 }}
          transition={{ type: "spring", duration: 0.25, bounce: 0.35 }}
          className="inline-flex"
        >
          {done ? <Icon icon={icons.check} className="size-3.5 text-success" /> : <Icon icon={icons.copy} className="size-3.5" />}
        </motion.span>
      </AnimatePresence>
    </Button>
  );

  if (!tooltip) return button;
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipPopup side="top">{done ? "Copied" : label}</TooltipPopup>
    </Tooltip>
  );
}
