import { useNav } from "@/app/store";

export function FileViewer() {
  const viewer = useNav((s) => s.viewer);
  const close = useNav((s) => s.closeFile);
  return (
    <aside className="w-96 border-l p-4 text-sm">
      {viewer?.path}
      <button type="button" onClick={close}>Close</button>
    </aside>
  );
}
