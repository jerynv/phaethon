// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc. See THIRD_PARTY_NOTICES.md.
import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Settings page building blocks shared by every settings panel: a page with
 * a heading, titled groups of rows, and rows with a label, an optional
 * description and a control. Rows stack below 32rem of width.
 */

function SettingsPage({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("mx-auto flex w-full max-w-3xl flex-col gap-8 px-5 py-6 sm:px-8 sm:py-8", className)}
      data-slot="settings-page"
      {...props}
    />
  );
}

function SettingsSection({
  title,
  description,
  action,
  className,
  children,
  headingLevel = 3,
  ...props
}: Omit<React.ComponentProps<"section">, "title"> & {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  headingLevel?: 2 | 3;
}) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <section className={cn("flex flex-col gap-2.5", className)} data-slot="settings-section" {...props}>
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1 px-1">
        <div className="flex min-w-0 flex-col gap-0.5">
          <Heading className="font-semibold text-foreground text-sm">{title}</Heading>
          {description ? <p className="text-muted-foreground text-sm">{description}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function SettingsGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "relative overflow-visible rounded-xl border border-border bg-card text-card-foreground shadow-xs/5 [&>*+*]:border-t [&>*+*]:border-border",
        className,
      )}
      data-slot="settings-group"
      {...props}
    />
  );
}

function SettingsRow({
  title,
  description,
  control,
  htmlFor,
  labelId,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<"div">, "title"> & {
  title: React.ReactNode;
  description?: React.ReactNode;
  control?: React.ReactNode;
  /** The control's id, so the title becomes its label. */
  htmlFor?: string;
  /** An id for the title, for controls labelled by it (aria-labelledby). */
  labelId?: string;
}) {
  const Title = htmlFor ? "label" : "div";
  return (
    <div className={cn("@container/settings-row px-4 py-3.5", className)} data-slot="settings-row" {...props}>
      <div className="flex flex-col gap-3 @min-[32rem]/settings-row:flex-row @min-[32rem]/settings-row:items-center @min-[32rem]/settings-row:justify-between">
        <div className="flex min-w-0 flex-col gap-0.5">
          <Title id={labelId} htmlFor={htmlFor} className="font-medium text-foreground text-sm">
            {title}
          </Title>
          {description ? <div className="text-muted-foreground text-sm leading-normal">{description}</div> : null}
        </div>
        {control ? <div className="flex shrink-0 flex-wrap items-center gap-2">{control}</div> : null}
      </div>
      {children}
    </div>
  );
}

export { SettingsPage, SettingsSection, SettingsGroup, SettingsRow };
