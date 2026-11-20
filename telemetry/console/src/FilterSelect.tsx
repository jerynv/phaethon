import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";

/** The same portalled, keyboard-accessible select used throughout the desktop app. */
export function FilterSelect({ label, value, options, onChange, disabled, className }: { label: string; value: string; options: { value: string; label: string }[]; onChange: (value: string) => void; disabled?: boolean; className?: string }) {
  return <Select value={value} onValueChange={(next) => { if (next !== null) onChange(next); }} disabled={disabled} items={options}>
    <SelectTrigger aria-label={label} className={className}><SelectValue /></SelectTrigger>
    <SelectPopup alignItemWithTrigger={false}>{options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectPopup>
  </Select>;
}
