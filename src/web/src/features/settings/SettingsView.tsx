import { useNav } from "@/app/store";

export function SettingsView() {
  const close = useNav((s) => s.closeSettings);
  return (
    <div className="p-6">
      <button type="button" onClick={close}>Back</button>
    </div>
  );
}
