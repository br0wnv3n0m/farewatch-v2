import type { CellOption, Leg } from '../backend/types';
import { clock, minutes, money, shortDate } from '../lib/format';
import { googleFlightsLink, selfTransfers, type LinkTrip } from '../lib/googleLink';
import { countryName } from './CountryPicker';

function LegView({ title, leg }: { title: string; leg: Leg }) {
  const first = leg.flights[0];
  const last = leg.flights[leg.flights.length - 1];
  const moves = selfTransfers(leg);
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
      {moves.map((m, i) => (
        <p key={i} className="self-transfer">
          ⚠ Self-transfer: you land at {m.from} and must get yourself to {m.to}, collect bags and check in again.
        </p>
      ))}
      <div className="muted small">
        {first.departure_airport.id} {clock(first.departure_airport.time)} → {last.arrival_airport.id} {clock(last.arrival_airport.time)} (local times)
      </div>
    </div>
  );
}

interface Props {
  options: CellOption[];
  currency: string;
  message?: string;
  /** Travellers and cabin, for the Google Flights link. Without it there is no link. */
  trip?: LinkTrip;
  /** Opens a link outside the app (system browser). */
  onOpenLink?: (url: string) => void;
}

export function FlightDetails({ options, currency, message, trip, onOpenLink }: Props) {
  if (message) return <section className="details card"><p className="warn">{message}</p></section>;
  if (!options.length) return <section className="details card"><p className="muted">No allowed flight for these dates with the current filters.</p></section>;
  return (
    <section className="details card">
      {options.slice(0, 5).map((o, i) => {
        const link = trip && onOpenLink ? googleFlightsLink(o, trip) : null;
        const selfTransfer = selfTransfers(o.out).length > 0 || (!!o.back && selfTransfers(o.back).length > 0);
        const summary = (
          <>
            <span className="price">{money(o.price, currency)}</span>
            {i === 0 && <span className="badge">Cheapest</span>}
            {selfTransfer ? (
              <span className="badge danger" title="Separate flights joined together. You move between them yourself.">Self-transfer</span>
            ) : (
              <span className="badge plain" title="Sold as one trip. Google Flights hides separate-ticket and self-transfer trips for this search.">One booking</span>
            )}
            <span className="muted"> {o.airlines.join(' + ')}</span>
            {link && <span className="book-link">Book ↗</span>}
          </>
        );
        return (
          <article key={i} className={i === 0 ? 'option best' : 'option'}>
            {link ? (
              <a
                className="option-price clickable"
                href={link}
                target="_blank"
                rel="noopener noreferrer"
                title="Open this exact trip on Google Flights to see booking sites"
                onClick={(e) => { e.preventDefault(); onOpenLink!(link); }}
              >
                {summary}
              </a>
            ) : (
              <div className="option-price">{summary}</div>
            )}
            <div className="legs">
              <LegView title="Leave" leg={o.out} />
              {o.back && <LegView title="Return" leg={o.back} />}
            </div>
          </article>
        );
      })}
      <p className="muted small">
        Prices are for all travellers. Checked bags are not verified. Click a price to open that trip on Google Flights and pick a booking site; the price there may have changed.
      </p>
    </section>
  );
}
