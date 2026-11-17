// Fake itineraries for demo mode (no network).
import type { CellOption, Combo, Leg, LookupRequest } from './types';

const HUBS = [
  { id: 'LHR', code: 'BA' },
  { id: 'FRA', code: 'LH' },
  { id: 'YYZ', code: 'AC' },
  { id: 'DXB', code: 'EK' },
  { id: 'SEA', code: 'AS' }, // US: removed when US is blocked
];

function leg(from: string, to: string, day: string, hub: (typeof HUBS)[number], price: number): Leg {
  return {
    price,
    flights: [
      { departure_airport: { id: from, time: `${day} 09:10` }, arrival_airport: { id: hub.id, time: `${day} 16:40` }, flight_number: `${hub.code}${100 + (price % 800)}`, airline: hub.code },
      { departure_airport: { id: hub.id, time: `${day} 19:05` }, arrival_airport: { id: to, time: `${day} 23:55` }, flight_number: `${hub.code}${900 + (price % 90)}`, airline: hub.code },
    ],
    layovers: [{ id: hub.id, duration: 145 }],
  };
}

export function fakeOptions(req: Pick<LookupRequest, 'origin' | 'destination' | 'blockedCountries'>, c: Combo, seed: number): CellOption[] {
  const hubs = HUBS.filter((h) => !(h.id === 'SEA' && req.blockedCountries.includes('US')));
  return hubs
    .map((hub, i) => {
      const price = Math.round(900 + ((seed * 37 + i * 211) % 700));
      const out = leg(req.origin, req.destination, c.out, hub, price);
      const back = c.back ? leg(req.destination, req.origin, c.back, hub, price) : null;
      return { price, out, back, airlines: [hub.code] };
    })
    .sort((a, b) => a.price - b.price);
}
