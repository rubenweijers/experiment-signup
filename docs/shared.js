import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/+esm';
import { SUPABASE_ANON_KEY, SUPABASE_URL, TIMEZONE } from './config.js';

export const isConfigured = !SUPABASE_URL.includes('YOUR-PROJECT-REF');
export const sb = isConfigured ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

// Builds DOM with text nodes only. Names come from a public form and end up on the
// admin page, so user data must never pass through innerHTML.
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  el.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key in el) el[key] = value;
    else el.setAttribute(key, value);
  }
  return el;
}

// [date, time] of an instant on the lab's wall clock: ['2026-11-12', '14:00'].
export function localParts(iso) {
  const [date, time] = new Date(iso).toLocaleString('sv-SE', { timeZone: TIMEZONE }).split(' ');
  return [date, time.slice(0, 5)];
}

// The instant at which the lab's wall clock shows this date and time.
export function zonedToIso(date, time) {
  const wall = Date.parse(`${date}T${time}:00Z`);
  const offset = (ms) => Date.parse(
    `${new Date(ms).toLocaleString('sv-SE', { timeZone: TIMEZONE }).replace(' ', 'T')}Z`) - ms;
  return new Date(wall - offset(wall - offset(wall))).toISOString();
}

function dateParts(iso, weekday, month) {
  const parts = new Intl.DateTimeFormat('en-GB', { weekday, day: 'numeric', month, timeZone: TIMEZONE })
    .formatToParts(new Date(iso));
  return Object.fromEntries(parts.map((p) => [p.type, p.value]));
}

// 'MON, 12 NOV'
export function fmtDay(iso) {
  const { weekday, day, month } = dateParts(iso, 'short', 'short');
  return `${weekday}, ${day} ${month}`.toUpperCase();
}

// 'Monday 12 November'
export function fmtLongDay(iso) {
  const { weekday, day, month } = dateParts(iso, 'long', 'long');
  return `${weekday} ${day} ${month}`;
}

// '14:00 – 15:00'
export function fmtRange(startIso, endIso) {
  return `${localParts(startIso)[1]} – ${localParts(endIso)[1]}`;
}

// Slots in order, as one array per lab-local day.
export function groupByDay(slots) {
  const days = new Map();
  for (const slot of slots) {
    const day = localParts(slot.start_time)[0];
    days.set(day, [...(days.get(day) ?? []), slot]);
  }
  return [...days.values()];
}
