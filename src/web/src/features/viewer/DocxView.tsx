import { renderAsync } from "docx-preview";
import { useEffect, useRef, useState } from "react";

/** A Word document drawn in place by docx-preview (Apache-2.0), loaded only when one is opened. */
export default function DocxView({ data, label }: { data: ArrayBuffer; label: string }) {
  const box = useRef<HTMLDivElement>(null);
  const styles = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.replaceChildren();
    renderAsync(data, el, styles.current ?? undefined, {
      className: "ph-docx",
      inWrapper: true,
      ignoreLastRenderedPageBreak: true,
      experimental: false,
      useBase64URL: true,
    }).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [data]);
  if (error) return <p className="p-6 text-sm">This document couldn’t be read: {error}</p>;
  return (
    <div tabIndex={0} role="document" aria-label={label} className="min-h-0 flex-1 overflow-auto bg-muted/60 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
      <div ref={styles} hidden />
      <div ref={box} className="[&_.ph-docx-wrapper]:bg-transparent! [&_.ph-docx-wrapper]:p-4! [&_section.ph-docx]:mx-auto [&_section.ph-docx]:shadow-sm" />
    </div>
  );
}
