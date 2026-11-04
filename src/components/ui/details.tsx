import type { ComponentProps } from "react";
import { Disclosure } from "vic-ui";

export function Details({ summary = "Details", ...props }: Omit<ComponentProps<typeof Disclosure>, "summary"> & { summary?: ComponentProps<typeof Disclosure>["summary"] }) {
  return <Disclosure {...props} summary={summary} />;
}
