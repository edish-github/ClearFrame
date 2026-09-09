export interface ChipOption<T extends string> { value: T; label: string; count?: number; }

export function Chips<T extends string>({ options, value, onChange, disabled }: {
  options: ChipOption<T>[]; value: T | null; onChange: (v: T) => void; disabled?: boolean;
}) {
  return (
    <div className="chips">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={["chip", value === o.value && "is-active"].filter(Boolean).join(" ")}
          aria-pressed={value === o.value}
          disabled={disabled}
          onClick={() => onChange(o.value)}
        >
          {o.label}
          {o.count !== undefined && <span className="chip__count">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}
