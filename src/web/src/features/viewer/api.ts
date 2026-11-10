import { invoke } from "@/lib/core";
import type { FileView } from "./kinds";

/** A file in the space (or a course it may see) for the viewer; text comes inline. */
export const fileView = (space: string, path: string) => invoke<FileView>("file_view", { space, path });

/** A PDF's, picture's or document's bytes, for the viewer. */
export const fileBytes = (space: string, path: string) => invoke<ArrayBuffer>("file_bytes", { space, path });

/** Opens the file in its own app, or shows it in the file manager (`reveal`). */
export const fileOpen = (space: string, path: string, reveal = false) => invoke<void>("file_open", { space, path, reveal });
