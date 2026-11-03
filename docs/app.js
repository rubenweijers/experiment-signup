import { COMPENSATION_LABEL, CONTACT_EMAIL, DURATION_LABEL, LOCATION_LABEL, STUDY_TITLE } from './config.js';
import { fmtDay, fmtRange, groupByDay, h, isConfigured, sb } from './shared.js';

const $ = (id) => document.getElementById(id);

const BOOKING_ERRORS = {
  SLOT_FULL: 'That timeslot has just been taken. Please choose another one.',
  SLOT_UNAVAILABLE: 'That timeslot is no longer available. Please choose another one.',
  ALREADY_BOOKED: 'This email already has a booking, or has already taken part in this study. Each person can take part once.',
  TOO_MANY_REQUESTS: 'A booking was just made from this browser. Please wait a minute and try again.',
  INVALID_INPUT: 'Please check your name and email.',
};
const CANCEL_ERRORS = {
  INVALID_TOKEN: 'This cancellation link is not valid.',
  CANNOT_CANCEL: 'This booking can no longer be cancelled because the session has started or finished.',
};

let selectedSlot = null;

function show(view) {
  for (const id of ['view-booking', 'view-confirm', 'view-cancel']) $(id).hidden = id !== view;
}

function showError(el, message) {
  el.textContent = message;
  el.hidden = !message;
}

function cancelUrl(token) {
  return `${location.origin}${location.pathname}?cancel=${token}`;
}

// --- Booking ---

function updateEligibility() {
  $('slots-section').hidden = !($('eligible-student').checked && $('eligible-new').checked);
  if ($('slots-section').hidden) selectSlot(null);
}

function selectSlot(slot) {
  selectedSlot = slot;
  $('book-form').hidden = !slot;
  for (const pill of document.querySelectorAll('.pill')) {
    pill.setAttribute('aria-pressed', String(pill.dataset.id === slot?.id));
  }
  if (slot) {
    $('selected-slot').textContent = `${fmtDay(slot.start_time)} | ${fmtRange(slot.start_time, slot.end_time)}`;
  }
}

async function loadSlots(notice = '') {
  const list = $('slot-list');
  list.replaceChildren(h('p', {}, 'Loading timeslots…'));
  const { data, error } = await sb.rpc('get_available_slots');
  if (error) {
    list.replaceChildren(h('p', { className: 'error' }, 'Could not load timeslots. Please refresh the page.'));
    return;
  }
  list.replaceChildren(
    notice ? h('p', { className: 'error', role: 'alert' }, notice) : '',
    data.length ? '' : h('p', {}, 'No timeslots are available right now. Please check back soon.'),
    ...groupByDay(data).map((slots) => h('div', { className: 'day' },
      h('h3', { className: 'mono' }, fmtDay(slots[0].start_time)),
      h('div', { className: 'pills' }, slots.map((slot) => {
        const pill = h('button', {
          type: 'button',
          className: 'pill mono',
          'aria-pressed': 'false',
          onclick: () => selectSlot(slot),
        }, `${fmtRange(slot.start_time, slot.end_time)} | AVAILABLE`);
        pill.dataset.id = slot.id;
        return pill;
      })))));
}

// A random token per browser, not a device fingerprint. Only used for the booking cooldown.
function clientToken() {
  try {
    let token = localStorage.getItem('signup_client');
    if (!token) {
      token = crypto.randomUUID();
      localStorage.setItem('signup_client', token);
    }
    return token;
  } catch {
    return null;
  }
}

async function submitBooking(event) {
  event.preventDefault();
  const form = event.target;
  const firstName = form.first_name.value.trim();
  const email = form.email.value.trim();

  let problem = '';
  if (!firstName) problem = 'Please enter your first name.';
  else if (!email || !form.email.checkValidity()) problem = 'Please enter a valid email address.';
  else if (!form.consent.checked) problem = 'Please tick the consent box to book a timeslot.';
  showError($('book-error'), problem);
  if (problem) return;

  $('book-submit').disabled = true;
  const { data, error } = await sb.rpc('book_slot', {
    p_slot_id: selectedSlot.id,
    p_first_name: firstName,
    p_email: email,
    p_client_hash: clientToken(),
  });
  $('book-submit').disabled = false;

  if (!error) {
    showConfirmation(data);
  } else if (error.message === 'SLOT_FULL' || error.message === 'SLOT_UNAVAILABLE') {
    // The form stays filled in, hidden, for when they pick another slot.
    selectSlot(null);
    await loadSlots(BOOKING_ERRORS[error.message]);
    $('slots-section').scrollIntoView();
  } else {
    showError($('book-error'), BOOKING_ERRORS[error.message] ?? 'Something went wrong. Please try again.');
  }
}

function showConfirmation(booking) {
  const link = cancelUrl(booking.cancel_token);
  $('confirm-date').textContent = fmtDay(booking.start_time);
  $('confirm-time').textContent = fmtRange(booking.start_time, booking.end_time);
  $('confirm-room').textContent = booking.room;
  $('confirm-cancel-link').href = link;
  $('confirm-cancel-link').textContent = link;
  $('add-outlook').href = outlookUrl(booking);
  $('add-google').href = googleUrl(booking);
  $('download-ics').onclick = () => downloadIcs(booking, link);
  show('view-confirm');
  scrollTo(0, 0);
}

// --- Calendar invite ---

function icsText(text) {
  return text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

function icsTime(iso) {
  return new Date(iso).toISOString().replace(/[-:]|\.\d{3}/g, '');
}

// RFC 5545 limits lines to 75 octets, and room names may hold multi-byte characters.
function foldIcsLine(line) {
  const encoder = new TextEncoder();
  const chunks = [];
  let chunk = '';
  let octets = 0;
  for (const char of line) {
    const size = encoder.encode(char).length;
    if (octets + size > 75) {
      chunks.push(chunk);
      chunk = ' ';
      octets = 1;
    }
    chunk += char;
    octets += size;
  }
  chunks.push(chunk);
  return chunks.join('\r\n');
}

// The label may already name the room.
function eventLocation(booking) {
  return LOCATION_LABEL.includes(booking.room) ? LOCATION_LABEL : `${booking.room}, ${LOCATION_LABEL}`;
}

// These links hand the event to Microsoft or Google, so they leave out the personal cancel link.
function outlookUrl(booking) {
  const params = new URLSearchParams({
    path: '/calendar/action/compose',
    rru: 'addevent',
    subject: STUDY_TITLE,
    startdt: new Date(booking.start_time).toISOString(),
    enddt: new Date(booking.end_time).toISOString(),
    location: eventLocation(booking),
    body: `Compensation: ${COMPENSATION_LABEL}`,
  });
  return `https://outlook.office.com/calendar/0/deeplink/compose?${params}`;
}

function googleUrl(booking) {
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: STUDY_TITLE,
    dates: `${icsTime(booking.start_time)}/${icsTime(booking.end_time)}`,
    location: eventLocation(booking),
    details: `Compensation: ${COMPENSATION_LABEL}`,
  });
  return `https://calendar.google.com/calendar/render?${params}`;
}

function downloadIcs(booking, link) {
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Experiment Sign-up//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${booking.cancel_token}@experiment-signup`,
    `DTSTAMP:${icsTime(new Date().toISOString())}`,
    `DTSTART:${icsTime(booking.start_time)}`,
    `DTEND:${icsTime(booking.end_time)}`,
    `SUMMARY:${icsText(STUDY_TITLE)}`,
    `LOCATION:${icsText(eventLocation(booking))}`,
    `DESCRIPTION:${icsText(`Compensation: ${COMPENSATION_LABEL}\nCannot make it? Cancel here: ${link}`)}`,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].map(foldIcsLine).join('\r\n');

  const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' }));
  const anchor = h('a', { href: url, download: 'lab-appointment.ics' });
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// --- Cancellation ---

function showCancelDone(title, text) {
  $('cancel-title').textContent = title;
  $('cancel-text').textContent = text;
  $('cancel-submit').hidden = true;
  $('cancel-back').hidden = false;
}

function startCancelView(token) {
  show('view-cancel');
  document.querySelector('.masthead').hidden = true;
  document.querySelector('.footer').hidden = true;
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(token)) {
    showCancelDone('Invalid link', CANCEL_ERRORS.INVALID_TOKEN);
    return;
  }
  // Cancelling takes a click, so link previews in chat apps cannot trigger it by opening the URL.
  $('cancel-submit').onclick = async () => {
    $('cancel-submit').disabled = true;
    const { data, error } = await sb.rpc('cancel_booking', { p_cancel_token: token });
    $('cancel-submit').disabled = false;
    if (error) {
      showError($('cancel-error'), CANCEL_ERRORS[error.message] ?? 'Something went wrong. Please try again.');
      return;
    }
    showError($('cancel-error'), '');
    showCancelDone('Booking cancelled', `Your session on ${fmtDay(data.start_time)} has been canceled.`);
  };
}

// --- Start ---

$('study-title').textContent = STUDY_TITLE;
$('fact-duration').textContent = DURATION_LABEL;
const [beforeAmount, amount = '', afterAmount = ''] = COMPENSATION_LABEL.split(/(€\d+)/);
$('fact-compensation').replaceChildren(beforeAmount, h('span', { className: 'money' }, amount), afterAmount);
$('fact-location').textContent = LOCATION_LABEL;
$('contact').href = `mailto:${CONTACT_EMAIL}`;
$('contact').textContent = CONTACT_EMAIL;

if (!isConfigured) {
  showError($('fatal'), 'Sign-up is not configured yet: set SUPABASE_URL and SUPABASE_ANON_KEY in config.js.');
} else {
  const cancelToken = new URLSearchParams(location.search).get('cancel');
  if (cancelToken !== null) {
    startCancelView(cancelToken);
  } else {
    show('view-booking');
    for (const id of ['eligible-student', 'eligible-new']) $(id).addEventListener('change', updateEligibility);
    $('book-form').addEventListener('submit', submitBooking);
    loadSlots();
  }
}
