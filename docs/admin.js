import { COMPENSATION_LABEL, DEFAULT_ROOM, DEFAULT_SLOT_MINUTES, QUOTA_PER_CONDITION, STUDY_TITLE } from './config.js';
import { countrySelect, fmtDay, fmtLongDay, fmtRange, groupByDay, h, isConfigured, localParts, sb, toE164, zonedToIso } from './shared.js';

const $ = (id) => document.getElementById(id);

const GROUP_SIZE = { '2P': 2, '3P': 3 };
const CONDITION_LABEL = { '2P': '2-Person Condition', '3P': '3-Person Condition' };
const STATUS_ACTIONS = [
  ['booked', 'Booked'],
  ['confirmed', 'Confirmed'],
  ['completed', 'Completed'],
  ['no_show', 'No-Show'],
];
const SEAT_TAKEN = new Set(['booked', 'confirmed', 'completed']);

const state = { slots: [], showPast: false, walkInFor: null, editing: null };

function showError(el, message) {
  el.textContent = message;
  el.hidden = !message;
}

// Runs one Supabase write, then reloads, so the page always shows what the database holds.
async function write(operation, duplicateMessage = 'That value is already in use.') {
  const { error } = await operation;
  if (error) {
    showError($('admin-error'), error.code === '23505' ? duplicateMessage : error.message);
    scrollTo(0, 0);
    return false;
  }
  showError($('admin-error'), '');
  await load();
  return true;
}

async function load() {
  const { data, error } = await sb.from('slots').select('*, signups(*)').order('start_time');
  if (error) {
    showError($('admin-error'), error.message);
    return;
  }
  state.slots = data;
  render();
}

function render() {
  renderQuota();
  renderRoster();
}

// --- Quota ---

function isGroupComplete(slot) {
  const completed = slot.signups.filter((s) => s.status === 'completed').length;
  return completed >= GROUP_SIZE[slot.condition];
}

function renderQuota() {
  $('quota').replaceChildren(...Object.keys(GROUP_SIZE).map((condition) => {
    const done = state.slots.filter((s) => s.condition === condition && isGroupComplete(s)).length;
    const fill = h('div', { className: 'bar-fill' });
    fill.style.width = `${Math.min(100, (done / QUOTA_PER_CONDITION) * 100)}%`;
    return h('div', { className: 'quota-row' },
      h('div', { className: 'quota-label' },
        h('span', {}, CONDITION_LABEL[condition]),
        h('span', { className: 'mono' }, `${done} / ${QUOTA_PER_CONDITION}`)),
      h('div', { className: 'bar' }, fill));
  }));
}

// --- Slots ---

function slotFromForm(form) {
  const { date, start, end, room, capacity } = Object.fromEntries(new FormData(form));
  if (!date || !start || !end || !room.trim()) return { problem: 'Date, start, end and room are all required.' };
  if (end <= start) return { problem: 'The end time must be after the start time.' };
  return {
    slot: {
      start_time: zonedToIso(date, start),
      end_time: zonedToIso(date, end),
      room: room.trim(),
      capacity: Number(capacity),
    },
  };
}

function addMinutes(time, minutes) {
  const [hours, mins] = time.split(':').map(Number);
  const total = Math.min(hours * 60 + mins + minutes, 23 * 60 + 59);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

async function addSlot(event) {
  event.preventDefault();
  const form = event.target;
  const { slot, problem } = slotFromForm(form);
  if (problem) {
    showError($('admin-error'), problem);
    scrollTo(0, 0);
    return;
  }
  if (await write(sb.from('slots').insert(slot))) {
    // Ready for the next consecutive slot on the same day.
    form.start.value = form.end.value;
    form.end.value = addMinutes(form.end.value, DEFAULT_SLOT_MINUTES);
  }
}

// Moves along the wall clock, so a session stays at 14:00 across a daylight-saving change.
function nextWeek(iso) {
  const [date, time] = localParts(iso);
  const next = new Date(Date.parse(`${date}T00:00:00Z`) + 7 * 86400000).toISOString().slice(0, 10);
  return zonedToIso(next, time);
}

function duplicateRows(slots) {
  return slots.map((s) => ({
    start_time: nextWeek(s.start_time),
    end_time: nextWeek(s.end_time),
    room: s.room,
    capacity: s.capacity,
  }));
}

function deleteSlot(slot) {
  const held = slot.signups.length;
  const warning = held
    ? `Delete this slot and the ${held} sign-up record(s) in it? Participants are not notified.`
    : 'Delete this slot?';
  if (confirm(warning)) write(sb.from('slots').delete().eq('id', slot.id));
}

// --- Roster ---

function whatsappUrl(signup, slot) {
  const cancelLink = new URL(`./?cancel=${signup.cancel_token}`, location.href).href;
  const message = [
    `Hi ${signup.first_name}, this is a reminder of your appointment for the ${STUDY_TITLE}.`,
    '',
    `Date: ${fmtLongDay(slot.start_time)}`,
    `Time: ${fmtRange(slot.start_time, slot.end_time)}`,
    `Room: ${slot.room}`,
    '',
    `You will receive ${COMPENSATION_LABEL} for taking part.`,
    '',
    'Please reply YES to confirm you are coming.',
    `If you cannot make it, please cancel here: ${cancelLink}`,
  ].join('\n');
  return `https://wa.me/${signup.phone.replace(/\D/g, '')}?text=${encodeURIComponent(message)}`;
}

function participantRow(signup, slot) {
  const setStatus = (status) => write(
    sb.from('signups').update({ status }).eq('id', signup.id),
    'This person already has another active booking or has taken part already.');

  return h('li', { className: `participant status-${signup.status}` },
    h('div', { className: 'participant-info' },
      h('strong', {}, signup.first_name),
      h('span', { className: 'mono' }, signup.phone),
      h('span', { className: 'email' }, signup.email),
      h('span', { className: 'badge mono' }, signup.status.replace('_', '-').toUpperCase())),
    h('div', { className: 'participant-actions' },
      signup.status !== 'cancelled' && h('a', {
        className: 'button primary small',
        href: whatsappUrl(signup, slot),
        target: '_blank',
        rel: 'noopener noreferrer',
      }, 'WhatsApp Reminder'),
      STATUS_ACTIONS.map(([status, label]) => h('button', {
        type: 'button',
        className: 'button small',
        disabled: signup.status === status,
        onclick: () => setStatus(status),
      }, label))));
}

function walkInRow(slot) {
  const code = countrySelect('country_code');
  const error = h('p', { className: 'error', role: 'alert', hidden: true });

  const submit = async (event) => {
    event.preventDefault();
    const form = event.target;
    const firstName = form.first_name.value.trim();
    const email = form.email.value.trim().toLowerCase();
    const phone = toE164(form.phone.value, code.value);
    if (!firstName || !email || !form.email.checkValidity() || !phone) {
      showError(error, 'Enter a name, a valid email and a complete phone number.');
      return;
    }
    const saved = await write(
      sb.from('signups').insert({ slot_id: slot.id, first_name: firstName, email, phone, status: 'confirmed' }),
      'This email or phone number already has an active booking or has taken part already.');
    if (saved) {
      state.walkInFor = null;
      render();
    }
  };

  return h('form', { className: 'walkin', noValidate: true, onsubmit: submit },
    h('input', { name: 'first_name', placeholder: 'First name', 'aria-label': 'First name' }),
    h('input', { name: 'email', type: 'email', placeholder: 'Email', 'aria-label': 'Email' }),
    h('div', { className: 'phone-row' }, code,
      h('input', { name: 'phone', type: 'tel', placeholder: '06 12345678', 'aria-label': 'Phone number' })),
    h('button', { className: 'button primary small', type: 'submit' }, 'Add'),
    error);
}

function editForm(slot) {
  const [date, start] = localParts(slot.start_time);
  const end = localParts(slot.end_time)[1];

  const submit = async (event) => {
    event.preventDefault();
    const form = event.target;
    const { slot: fields, problem } = slotFromForm(form);
    if (problem) {
      showError($('admin-error'), problem);
      scrollTo(0, 0);
      return;
    }
    fields.is_active = form.is_active.checked;
    fields.notes = form.notes.value.trim() || null;
    if (await write(sb.from('slots').update(fields).eq('id', slot.id))) {
      state.editing = null;
      render();
    }
  };

  return h('form', { className: 'slot-edit', noValidate: true, onsubmit: submit },
    h('div', { className: 'slot-fields' },
      h('label', { className: 'field' }, 'Date ', h('input', { name: 'date', type: 'date', value: date })),
      h('label', { className: 'field' }, 'Start ', h('input', { name: 'start', type: 'time', value: start })),
      h('label', { className: 'field' }, 'End ', h('input', { name: 'end', type: 'time', value: end })),
      h('label', { className: 'field' }, 'Room ', h('input', { name: 'room', value: slot.room })),
      h('label', { className: 'field' }, 'Capacity ',
        h('select', { name: 'capacity', value: String(slot.capacity) },
          [3, 4].map((c) => h('option', { value: String(c) }, String(c)))))),
    h('label', { className: 'field' }, 'Internal notes ', h('input', { name: 'notes', value: slot.notes ?? '' })),
    h('label', { className: 'check' }, h('input', { name: 'is_active', type: 'checkbox', checked: slot.is_active }),
      h('span', {}, 'Open for public booking')),
    h('div', { className: 'button-row' },
      h('button', { className: 'button primary small', type: 'submit' }, 'Save'),
      h('button', {
        className: 'button small',
        type: 'button',
        onclick: () => { state.editing = null; render(); },
      }, 'Close')));
}

function slotCard(slot) {
  const seats = slot.signups.filter((s) => SEAT_TAKEN.has(s.status)).length;
  const full = seats >= slot.capacity;
  const now = Date.now();
  const running = Date.parse(slot.start_time) <= now && now < Date.parse(slot.end_time);
  const signups = [...slot.signups].sort((a, b) =>
    (a.status === 'cancelled') - (b.status === 'cancelled') || a.created_at.localeCompare(b.created_at));

  const groupInput = h('input', {
    value: slot.group_id ?? '',
    placeholder: 'G01',
    'aria-label': 'Group ID',
    onchange: (event) => write(
      sb.from('slots').update({ group_id: event.target.value.trim() || null }).eq('id', slot.id),
      'That group ID is already used by another slot.'),
  });
  const conditionSelect = h('select', {
    'aria-label': 'Condition',
    value: slot.condition ?? '',
    onchange: (event) => write(sb.from('slots').update({ condition: event.target.value || null }).eq('id', slot.id)),
  }, h('option', { value: '' }, '—'), h('option', { value: '2P' }, '2P'), h('option', { value: '3P' }, '3P'));

  return h('article', { className: `slot${running ? ' running' : ''}${slot.is_active ? '' : ' inactive'}` },
    h('header', { className: 'slot-head' },
      h('div', { className: 'slot-title' },
        h('span', { className: 'mono strong' }, fmtRange(slot.start_time, slot.end_time)),
        h('span', {}, slot.room),
        h('span', { className: `badge mono${full ? ' solid' : ''}` }, `${seats}/${slot.capacity}${full ? ' FULL' : ''}`),
        running && h('span', { className: 'badge mono solid' }, 'NOW'),
        !slot.is_active && h('span', { className: 'badge mono' }, 'CLOSED')),
      h('div', { className: 'button-row' },
        h('button', {
          className: 'button small',
          type: 'button',
          onclick: () => { state.editing = state.editing === slot.id ? null : slot.id; render(); },
        }, 'Edit'),
        h('button', {
          className: 'button small',
          type: 'button',
          onclick: () => write(sb.from('slots').insert(duplicateRows([slot]))),
        }, 'Duplicate to next week'),
        h('button', { className: 'button small', type: 'button', onclick: () => deleteSlot(slot) }, 'Delete'))),

    state.editing === slot.id && editForm(slot),
    slot.notes && state.editing !== slot.id && h('p', { className: 'slot-notes' }, slot.notes),

    h('div', { className: 'group-row' },
      h('label', {}, 'Group ID ', groupInput),
      h('label', {}, 'Condition ', conditionSelect)),

    signups.length
      ? h('ul', { className: 'participants' }, signups.map((signup) => participantRow(signup, slot)))
      : h('p', { className: 'empty' }, 'No sign-ups yet.'),

    state.walkInFor === slot.id
      ? walkInRow(slot)
      : h('button', {
        className: 'button small',
        type: 'button',
        onclick: () => {
          state.walkInFor = slot.id;
          render();
          document.querySelector('.walkin input').focus();
        },
      }, '+ Add Walk-in'));
}

function renderRoster() {
  const today = localParts(new Date())[0];
  const visible = state.slots.filter((s) => state.showPast || localParts(s.start_time)[0] >= today);
  if (!visible.length) {
    $('roster').replaceChildren(h('p', { className: 'empty' }, 'No timeslots to show.'));
    return;
  }

  $('roster').replaceChildren(...groupByDay(visible).map((slots) => h('div', { className: 'day' },
    h('div', { className: 'day-head' },
      h('h3', { className: 'mono' }, fmtDay(slots[0].start_time)),
      h('button', {
        className: 'button small',
        type: 'button',
        onclick: () => write(sb.from('slots').insert(duplicateRows(slots))),
      }, 'Duplicate day to next week')),
    slots.map(slotCard))));
}

// --- Auth ---

function showLogin(message = '') {
  $('dashboard').hidden = true;
  $('login-form').hidden = false;
  showError($('login-error'), message);
}

async function enterDashboard() {
  const { data: allowed, error } = await sb.rpc('is_admin');
  if (error || !allowed) {
    await sb.auth.signOut();
    showLogin(error ? error.message : 'This account is not on the researcher allowlist. See README, step 3.');
    return;
  }
  $('login-form').hidden = true;
  $('dashboard').hidden = false;
  await load();
}

async function signIn(event) {
  event.preventDefault();
  const form = event.target;
  const { error } = await sb.auth.signInWithPassword({
    email: form.email.value.trim(),
    password: form.password.value,
  });
  if (error) {
    showLogin(error.message);
    return;
  }
  form.reset();
  await enterDashboard();
}

// --- Start ---

document.title = `${STUDY_TITLE}: admin`;
$('admin-title').textContent = `${STUDY_TITLE}: admin`;

if (!isConfigured) {
  showError($('fatal'), 'Not configured yet: set SUPABASE_URL and SUPABASE_ANON_KEY in config.js.');
} else {
  const addForm = $('add-slot');
  addForm.room.value = DEFAULT_ROOM;
  addForm.date.value = localParts(new Date())[0];
  addForm.start.addEventListener('change', () => {
    if (addForm.start.value) addForm.end.value = addMinutes(addForm.start.value, DEFAULT_SLOT_MINUTES);
  });
  addForm.addEventListener('submit', addSlot);
  $('login-form').addEventListener('submit', signIn);
  $('sign-out').addEventListener('click', async () => {
    await sb.auth.signOut();
    showLogin();
  });
  $('show-past').addEventListener('change', (event) => {
    state.showPast = event.target.checked;
    renderRoster();
  });

  const { data: { session } } = await sb.auth.getSession();
  if (session) await enterDashboard();
  else showLogin();
}
