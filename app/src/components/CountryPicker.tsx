import { useState } from 'react';
import countries from '../data/countries.json';

const NAMES = new Map(countries.map((c) => [c.code, c.name]));
export const countryName = (code: string) => NAMES.get(code) ?? code;

interface Props {
  value: string[];
  onChange: (codes: string[]) => void;
  label?: string;
}

/** Chips for blocked layover countries plus a searchable add box. */
export function CountryPicker({ value, onChange, label = 'No layovers in' }: Props) {
  const [text, setText] = useState('');
  const add = (code: string) => {
    if (code && !value.includes(code)) onChange([...value, code].sort());
    setText('');
  };
  const matches = text.length < 2 ? [] : countries.filter((c) => !value.includes(c.code) && (c.name.toLowerCase().includes(text.toLowerCase()) || c.code === text.toUpperCase())).slice(0, 6);
  return (
    <div className="field country-picker">
      <span className="label">{label}</span>
      <div className="chips">
        {value.map((code) => (
          <button type="button" key={code} className="chip" onClick={() => onChange(value.filter((c) => c !== code))} title="Remove">
            {countryName(code)} <span aria-hidden>×</span>
          </button>
        ))}
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (matches[0]) add(matches[0].code);
            }
          }}
          placeholder={value.length ? 'Add country' : 'Type a country'}
          aria-label="Add blocked country"
        />
      </div>
      {matches.length > 0 && (
        <ul className="suggest">
          {matches.map((c) => (
            <li key={c.code}>
              <button type="button" onClick={() => add(c.code)}>
                {c.name} <small>{c.code}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
