"use client";

import { useEffect, useState } from "react";
import { useAuiState } from "@assistant-ui/react";
import { useShallow } from "zustand/react/shallow";

import { fileBytes, imageType } from "@/lib/files";

const useFileSrc = (file: Blob | undefined) => {
  const [entry, setEntry] = useState<{ file: Blob; url: string } | undefined>(
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
  const { file, src, path, mediaType } = useAuiState(
    useShallow((s): { file?: File; src?: string; path?: string; mediaType?: string } => {
      if (s.attachment.type !== "image" && !s.attachment.contentType?.startsWith("image/")) return {};
      if (s.attachment.file) return { file: s.attachment.file };
      const src = s.attachment.content?.find((c) => c.type === "image")
        ?.image;
      if (src) return { src };
      if (!s.attachment.id.startsWith("saved-file:")) return {};
      return { path: s.attachment.id.slice("saved-file:".length), mediaType: imageType(s.attachment.name, s.attachment.contentType) };
    }),
  );
  const [saved, setSaved] = useState<{ space: string; path: string; blob: Blob }>();
  useEffect(() => {
    if (!space || !path) return;
    let stale = false;
    void fileBytes(space, path).then(
      (bytes) => {
        if (!stale) setSaved({ space, path, blob: new Blob([bytes], { type: mediaType }) });
      },
      () => { if (!stale) setSaved(undefined); },
    );
    return () => { stale = true; };
  }, [space, path, mediaType]);

  const savedBlob = saved?.space === space && saved?.path === path ? saved.blob : undefined;
  return useFileSrc(file ?? savedBlob) ?? src;
};
