"use client";

import { useEffect, useState } from "react";
import { useAuiState } from "@assistant-ui/react";
import { useShallow } from "zustand/react/shallow";

import { fileBytes, fileView } from "@/lib/files";

const useFileSrc = (file: File | undefined) => {
  const [entry, setEntry] = useState<{ file: File; url: string } | undefined>(
    undefined,
  );

  useEffect(() => {
    // The object URL is a browser resource whose lifetime has to straddle
    // commit, so allocation, revocation, and clearing the entry that names a
    // revoked URL all belong to the effect.
    if (!file) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setEntry(undefined);
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    setEntry({ file, url: objectUrl });

    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [file]);

  return entry !== undefined && entry.file === file ? entry.url : undefined;
};

export const useAttachmentSrc = (space = "") => {
  const { file, src, path } = useAuiState(
    useShallow((s): { file?: File; src?: string; path?: string } => {
      if (s.attachment.type !== "image") return {};
      if (s.attachment.file) return { file: s.attachment.file };
      if (s.attachment.id.startsWith("saved-file:")) return { path: s.attachment.id.slice("saved-file:".length) };
      const src = s.attachment.content?.filter((c) => c.type === "image")[0]
        ?.image;
      if (!src) return {};
      return { src };
    }),
  );

  const [saved, setSaved] = useState<{ space: string; path: string; url: string }>();
  useEffect(() => {
    if (!space || !path) return;
    let disposed = false;
    let objectUrl: string | undefined;
    void (async () => {
      try {
        const view = await fileView(space, path);
        if (disposed || view.kind !== "image" || view.tooBig) return;
        const bytes = await fileBytes(space, path);
        if (disposed) return;
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: view.mediaType }));
        setSaved({ space, path, url: objectUrl });
      } catch {
        // A missing or unsupported saved image keeps its file identity and viewer action.
      }
    })();
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [space, path]);

  return useFileSrc(file) ?? src ?? (saved?.space === space && saved.path === path ? saved.url : undefined);
};
