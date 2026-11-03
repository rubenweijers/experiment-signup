import { COMPENSATION_LABEL, CONTACT_EMAIL, DURATION_LABEL, LOCATION_LABEL, STUDY_TITLE } from './config.js';
import { fmtDay, fmtRange, groupByDay, h, isConfigured, sb } from './shared.js';

const $ = (id) => document.getElementById(id);

const BOOKING_ERRORS = {
  SLOT_FULL: 'That timeslot has just been taken. Please choose another one.',
  SLOT_UNAVAILABLE: 'That timeslot is no longer available. Please choose another one.',
  ALREADY_SIGNED_UP: 'This email is already signed up for one of these timeslots. Please check your email, or choose other timeslots.',
  ALREADY_BOOKED: 'This email already has a confirmed session, or has already taken part in this study. Each person can take part once.',
  TOO_MANY_REQUESTS: 'A sign-up was just made from this browser. Please wait a minute and try again.',
  INVALID_INPUT: 'Please check your name and email.',
};
const CANCEL_ERRORS = {
  INVALID_TOKEN: 'This cancellation link is not valid.',
  CANNOT_CANCEL: 'This booking can no longer be cancelled because the session has started or finished.',
};

const selectedSlots = new Map();

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
  if ($('slots-section').hidden) {
    selectedSlots.clear();
    renderSelection();
  }
}

function toggleSlot(slot) {
  if (!selectedSlots.delete(slot.id)) selectedSlots.set(slot.id, slot);
  renderSelection();
}

function renderSelection() {
  const count = selectedSlots.size;
  $('book-form').hidden = !count;
  for (const pill of document.querySelectorAll('.pill')) {
    pill.setAttribute('aria-pressed', String(selectedSlots.has(pill.dataset.id)));
  }
  const slots = [...selectedSlots.values()].sort((a, b) => a.start_time.localeCompare(b.start_time));
  $('selected-slot').replaceChildren(...slots.map((slot) =>
    h('div', {}, `${fmtDay(slot.start_time)} | ${fmtRange(slot.start_time, slot.end_time)}`)));
  $('book-submit').textContent = count === 1 ? 'Sign up for this timeslot' : `Sign up for these ${count} timeslots`;
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
    data.length ? '' : h('p', {}, `No timeslots available now, feel free to email ${CONTACT_EMAIL} with your availability or check back soon.`),
    ...groupByDay(data).map((slots) => h('div', { className: 'day' },
      h('h3', { className: 'mono' }, fmtDay(slots[0].start_time)),
      h('div', { className: 'pills' }, slots.map((slot) => {
        const pill = h('button', {
          type: 'button',
          className: 'pill mono',
          'aria-pressed': 'false',
          onclick: () => toggleSlot(slot),
        }, `${fmtRange(slot.start_time, slot.end_time)} | AVAILABLE`);
        pill.dataset.id = slot.id;
        return pill;
      })))));
  // Anything taken since it was selected drops out of the selection.
  for (const id of selectedSlots.keys()) {
    if (!data.some((slot) => slot.id === id)) selectedSlots.delete(id);
  }
  renderSelection();
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
  else if (!form.consent.checked) problem = 'Please tick the consent box to sign up.';
  showError($('book-error'), problem);
  if (problem) return;

  $('book-submit').disabled = true;
  const { data, error } = await sb.rpc('book_slots', {
    p_slot_ids: [...selectedSlots.keys()],
    p_first_name: firstName,
    p_email: email,
    p_client_hash: clientToken(),
  });
  $('book-submit').disabled = false;

  if (!error) {
    showConfirmation(data);
  } else if (error.message === 'SLOT_FULL' || error.message === 'SLOT_UNAVAILABLE') {
    // The form stays filled in, even if hidden, for when they pick another slot.
    await loadSlots(BOOKING_ERRORS[error.message]);
    $('slots-section').scrollIntoView();
  } else {
    showError($('book-error'), BOOKING_ERRORS[error.message] ?? 'Something went wrong. Please try again.');
  }
}

function showConfirmation(bookings) {
  const confirmed = bookings.find((booking) => booking.status === 'confirmed');
  $('confirm-title').textContent = confirmed ? 'Session confirmed' : 'Sign-up received';
  $('confirm-provisional').hidden = Boolean(confirmed);
  $('confirm-confirmed').hidden = !confirmed;
  $('confirm-sessions').replaceChildren(...(confirmed ? [confirmed] : bookings).flatMap((booking) => [
    h('dt', {}, fmtDay(booking.start_time)),
    h('dd', {}, `${fmtRange(booking.start_time, booking.end_time)} | `, h('a', { href: cancelUrl(booking.cancel_token) }, 'Cancel')),
  ]));
  show('view-confirm');
  scrollTo(0, 0);
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
    showCancelDone('Booking cancelled', `Your session on ${fmtDay(data.start_time)}, ${fmtRange(data.start_time, data.end_time)} has been cancelled.`);
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
