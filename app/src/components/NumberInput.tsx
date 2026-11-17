import { useEffect, useState } from 'react';

interface Props {
  value: number;
  onChange: (n: number) => void;
  min: number;
  max: number;
  step?: number | 'any';
  /** Whole numbers only (travellers, bags). */
  integer?: boolean;
}

/**
 * Number box that lets you clear it while typing.
 * The value is only sent up when it is a valid number in range;
 * when the box loses focus, an empty or out-of-range entry snaps back into range.
 */
export function NumberInput({ value, onChange, min, max, step, integer }: Props) {
  const [text, setText] = useState(String(value));

  // Follow outside changes (e.g. a form reset), but not while the text already means the same number.
  useEffect(() => {
    if (Number(text) !== value) setText(String(value));
  }, [value]);

  const valid = (n: number) => text.trim() !== '' && Number.isFinite(n) && n >= min && n <= max && (!integer || Number.isInteger(n));

  return (
    <input
      type="number"
      inputMode={integer ? 'numeric' : 'decimal'}
      min={min}
      max={max}
      step={step ?? (integer ? 1 : 'any')}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value.trim() !== '' && Number.isFinite(n) && n >= min && n <= max && (!integer || Number.isInteger(n))) onChange(n);
      }}
      onBlur={() => {
        const n = Number(text);
        if (valid(n)) return;
        const fixed = Number.isFinite(n) && text.trim() !== '' ? Math.min(max, Math.max(min, integer ? Math.round(n) : n)) : value;
        setText(String(fixed));
        if (fixed !== value) onChange(fixed);
      }}
    />
  );
}
