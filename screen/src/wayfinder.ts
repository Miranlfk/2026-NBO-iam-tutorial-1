// Reads the traveller's booked flights from the Wayfinder API with their own
// access token (scope bookings:read) and picks the next trip.

import { config } from "./config.js";
import type { Traveller } from "./oauth.js";

export interface BookedFlight {
  id: string;
  bookingReference?: string;
  status?: string;
  travelers?: number;
  bookedByAgentName?: string | null;
  flight: {
    from: string;
    to: string;
    airline: string;
    departureTime: string;
    arrivalTime: string;
    duration: string;
    stops: number;
    cabin: string;
    dates: string;
  };
}

export interface NextTrip {
  booking: BookedFlight | null;
  upcoming: boolean;
  activeCount: number;
}

export class WayfinderApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// Wayfinder stores trip dates as "Nov 05 - Nov 14" (no year): read the first
// date in the current year.
function tripStart(dates: string, year: number): Date | null {
  const match = /([A-Za-z]{3})\s+(\d{1,2})/.exec(dates || "");
  const month = match ? MONTHS.indexOf(match[1].toLowerCase()) : -1;

  return match && month >= 0 ? new Date(year, month, Number(match[2])) : null;
}

export function pickNextTrip(bookings: BookedFlight[], now = new Date()): NextTrip {
  const active = bookings.filter((booking) => booking.status !== "canceled");
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const upcoming = active
    .map((booking) => ({ booking, start: tripStart(booking.flight?.dates, now.getFullYear()) }))
    .filter((entry): entry is { booking: BookedFlight; start: Date } => entry.start !== null && entry.start >= today)
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  if (upcoming.length > 0) {
    return { booking: upcoming[0].booking, upcoming: true, activeCount: active.length };
  }

  // No dated future trip: show the most recent active booking (the API lists newest first).
  return { booking: active[0] || null, upcoming: false, activeCount: active.length };
}

export async function fetchNextTrip(accessToken: string, traveller: Traveller): Promise<NextTrip> {
  // The same headers the Wayfinder SPA sends, so the API resolves the same booking owner.
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${accessToken}`,
    "X-Wayfinder-Username": traveller.username,
    "X-Wayfinder-User-Id": traveller.username
  };

  if (traveller.email) {
    headers["X-Wayfinder-Email"] = traveller.email;
  }

  const response = await fetch(`${config.wayfinderApiUrl}/api/bookings/flights`, {
    headers,
    signal: AbortSignal.timeout(10_000)
  });
  const body = (await response.json().catch(() => ({}))) as { data?: BookedFlight[]; error?: string };

  if (!response.ok) {
    throw new WayfinderApiError(body.error || `Wayfinder API returned ${response.status}`, response.status);
  }

  return pickNextTrip(Array.isArray(body.data) ? body.data : []);
}
