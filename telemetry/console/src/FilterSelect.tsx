import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";

type Option = { value: string; label: string };

/** The same portalled, keyboard-accessible select used throughout the desktop app. */
export function FilterSelect({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  className?: string;
}) {
  return (
    <Select value={value} onValueChange={(next) => next !== null && onChange(next)} items={options}>
      <SelectTrigger aria-label={label} className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false}>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
