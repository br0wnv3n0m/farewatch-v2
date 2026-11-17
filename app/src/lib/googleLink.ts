// Builds a Google Flights link that opens ONE exact trip (the flights we found),
// so the user lands on Google's "booking options" page (airline + agency sites).
//
// Google keeps the search in the `tfs` URL parameter: a base64 protobuf ("Info").
// Same schema the engine uses (fast-flights + engine/farewatch_engine/google.py
// select_outbound). Field numbers:
//   Info:       3 = leg (repeated FlightData), 8 = passengers (packed enum),
//               9 = seat, 19 = trip (1 round trip, 2 one way)
//   FlightData: 2 = date, 13 = from {2: IATA}, 14 = to {2: IATA},
//               4 = selected flight (repeated): 1 from, 2 date, 3 to, 5 carrier, 6 number
import type { CellOption, Leg } from '../backend/types';

/** Trip details the link needs besides the flights themselves. */
export interface LinkTrip {
  adults: number;
  children: number;
  cabin: 1 | 2 | 3 | 4;
  currency: string;
}

const enc = new TextEncoder();

function varint(n: number): number[] {
  const out: number[] = [];
  while (n >= 128) {
    out.push((n & 127) | 128);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
}

const num = (field: number, value: number) => [...varint(field << 3), ...varint(value)];
function bytes(field: number, value: string | number[]): number[] {
  const data = typeof value === 'string' ? [...enc.encode(value)] : value;
  return [...varint((field << 3) | 2), ...varint(data.length), ...data];
}

function legData(leg: Leg): number[] {
  const first = leg.flights[0];
  const last = leg.flights[leg.flights.length - 1];
  const out = [
    ...bytes(2, first.departure_airport.time.slice(0, 10)),
    ...bytes(13, bytes(2, first.departure_airport.id)),
    ...bytes(14, bytes(2, last.arrival_airport.id)),
  ];
  for (const f of leg.flights) {
    out.push(...bytes(4, [
      ...bytes(1, f.departure_airport.id),
      ...bytes(2, f.departure_airport.time.slice(0, 10)),
      ...bytes(3, f.arrival_airport.id),
      ...bytes(5, f.flight_number.slice(0, 2)),
      ...bytes(6, f.flight_number.slice(2)),
    ]));
  }
  return out;
}

/** Link to Google's booking page for this exact trip, or null if the data is incomplete. */
export function googleFlightsLink(option: CellOption, trip: LinkTrip): string | null {
  const legs = option.back ? [option.out, option.back] : [option.out];
  if (legs.some((l) => !l.flights.length || l.flights.some((f) => !/^[A-Z0-9]{2}\d{1,4}$/.test(f.flight_number)))) return null;
  const passengers = [...Array(trip.adults).fill(1), ...Array(trip.children).fill(2)];
  const info = [
    ...legs.flatMap((l) => bytes(3, legData(l))),
    ...bytes(8, passengers.flatMap((p) => varint(p))),
    ...num(9, trip.cabin),
    ...num(19, option.back ? 1 : 2),
  ];
  const tfs = btoa(String.fromCharCode(...info));
  const q = new URLSearchParams({ tfs, hl: 'en', curr: trip.currency });
  return `https://www.google.com/travel/flights/booking?${q}`;
}

/**
 * Places where the traveller must move on their own: arriving at one airport and
 * leaving from a different one. The engine rejects these today (google.py), and it
 * asks Google to hide separate-ticket / self-transfer trips, so this is a safety net.
 */
export function selfTransfers(leg: Leg): { from: string; to: string }[] {
  const list: { from: string; to: string }[] = [];
  for (let i = 0; i + 1 < leg.flights.length; i++) {
    const from = leg.flights[i].arrival_airport.id;
    const to = leg.flights[i + 1].departure_airport.id;
    if (from !== to) list.push({ from, to });
  }
  return list;
}
