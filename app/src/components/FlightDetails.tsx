import type { CellOption, Leg } from '../backend/types';
import { clock, minutes, money, shortDate } from '../lib/format';
import { countryName } from './CountryPicker';

function LegView({ title, leg }: { title: string; leg: Leg }) {
  const first = leg.flights[0];
  const last = leg.flights[leg.flights.length - 1];
  return (
    <div className="leg">
      <div className="leg-head">
        <strong>{title}</strong> · {shortDate(first.departure_airport.time.slice(0, 10))} · {leg.flights.length === 1 ? 'Non-stop' : `${leg.flights.length - 1} stop${leg.flights.length > 2 ? 's' : ''}`}
      </div>
      <ol className="segments">
        {leg.flights.map((f, i) => (
          <li key={i}>
            <span className="time">{clock(f.departure_airport.time)}</span> {f.departure_airport.id} → <span className="time">{clock(f.arrival_airport.time)}</span> {f.arrival_airport.id}
            <span className="muted"> · {f.flight_number} {f.airline !== f.flight_number.slice(0, 2) ? `(${f.airline})` : ''}</span>
            {leg.layovers[i] && (
              <div className="layover">
                Change in {leg.layovers[i].id}
                {leg.layovers[i].country ? `, ${countryName(leg.layovers[i].country!)}` : ''} · {minutes(leg.layovers[i].duration)}
              </div>
            )}
          </li>
        ))}
      </ol>
      <div className="muted small">
        {first.departure_airport.id} {clock(first.departure_airport.time)} → {last.arrival_airport.id} {clock(last.arrival_airport.time)} (local times)
      </div>
    </div>
  );
}

export function FlightDetails({ options, currency, message }: { options: CellOption[]; currency: string; message?: string }) {
  if (message) return <section className="details card"><p className="warn">{message}</p></section>;
  if (!options.length) return <section className="details card"><p className="muted">No allowed flight for these dates with the current filters.</p></section>;
  return (
    <section className="details card">
      {options.slice(0, 5).map((o, i) => (
        <article key={i} className={i === 0 ? 'option best' : 'option'}>
          <div className="option-price">
            <span className="price">{money(o.price, currency)}</span>
            {i === 0 && <span className="badge">Cheapest</span>}
            <span className="muted"> {o.airlines.join(' + ')}</span>
          </div>
          <div className="legs">
            <LegView title="Leave" leg={o.out} />
            {o.back && <LegView title="Return" leg={o.back} />}
          </div>
        </article>
      ))}
      <p className="muted small">Prices are for all travellers. Checked bags are not verified. Book on Google Flights to confirm.</p>
    </section>
  );
}
