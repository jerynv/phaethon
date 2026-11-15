import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Cards (docs/UI-REBUILD.md › Primitives › Card): 16 px radius, a hairline,
 * generous padding, a shadow you only notice on a grey well. `well` is the
 * grey inset box inside a card ("What you get", a draft's body); `ghost` drops
 * the frame for a card that sits on art.
 *
 *   <Card>
 *     <CardMedia><ArtCanvas palette="dawn" /></CardMedia>
 *     <CardHeader><CardTitle/><CardDescription/><CardAction/></CardHeader>
 *     <CardContent/>
 *     <CardFooter/>
 *   </Card>
 */
const cardVariants = cva("relative flex flex-col overflow-hidden text-card-foreground", {
  variants: {
    variant: {
      default: "rounded-card border bg-card",
      well: "rounded-xl border border-border/70 bg-well",
      ghost: "rounded-card bg-card",
      interactive:
        "rounded-card border bg-card transition-colors duration-150 hover:border-border-strong focus-visible:ring-2 focus-visible:ring-ring outline-none",
    },
  },
  defaultVariants: { variant: "default" },
});

function Card({ className, variant, render, ...props }: useRender.ComponentProps<"div"> & VariantProps<typeof cardVariants>) {
  return useRender({
    defaultTagName: "div",
    render,
    props: mergeProps<"div">({ className: cn(cardVariants({ variant }), className), "data-slot": "card", "data-variant": variant ?? "default" } as React.ComponentProps<"div">, props),
  });
}

/** Art or an image across the top; the card's radius clips it. */
function CardMedia({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-media" className={cn("relative h-24 shrink-0 overflow-hidden", className)} {...props} />;
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-header" className={cn("relative flex flex-col gap-1 px-5 pt-5 pb-3 has-[[data-slot=card-action]]:pr-24 last:pb-5", className)} {...props} />;
}

function CardTitle({ className, ...props }: React.ComponentProps<"h3">) {
  return <h3 data-slot="card-title" className={cn("font-medium text-base text-foreground tracking-title", className)} {...props} />;
}

function CardDescription({ className, ...props }: React.ComponentProps<"p">) {
  return <p data-slot="card-description" className={cn("text-muted-foreground text-sm", className)} {...props} />;
}

/** A badge, price or button pinned to the header's top-right. */
function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-action" className={cn("absolute top-5 right-5 flex items-center gap-2", className)} {...props} />;
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-content" className={cn("flex flex-col gap-3 px-5 pb-5 first:pt-5", className)} {...props} />;
}

/** Actions under a hairline on a faint grey ("Decline · Send to all 28"). */
function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-footer" className={cn("mt-auto flex items-center justify-end gap-2 border-t bg-well px-5 py-3", className)} {...props} />;
}

export { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardMedia, CardTitle, cardVariants };
