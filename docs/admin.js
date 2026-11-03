import { DEFAULT_ROOM, DEFAULT_SLOT_MINUTES, QUOTA_PER_CONDITION, SIGNUP_LIMIT, STUDY_TITLE } from './config.js';
import { fmtDay, fmtRange, groupByDay, h, isConfigured, localParts, sb, zonedToIso } from './shared.js';

const $ = (id) => document.getElementById(id);

const GROUP_SIZE = { '2P': 2, '3P': 3 };
const CONDITION_LABEL = { '2P': 'HHR Condition', '3P': 'HHH Condition' };
const STATUS_ACTIONS = [
  ['completed', 'Completed'],
  ['no_show', 'No-Show'],
];
// A place in the group. 'booked' people have only signed up, and a slot takes more of them than it has places.
const SEAT_TAKEN = new Set(['confirmed', 'completed']);

const state = { slots: [], showPast: false, walkInFor: null, editing: null, invites: new Map() };

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

// '2026-11-09' -> '09/11/2026'
function displayDate(isoDate) {
  return isoDate.split('-').reverse().join('/');
}

// '09/11/2026' -> '2026-11-09', or null if that is not a real date.
function parseDisplayDate(text) {
  const match = text.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;
  const iso = `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
  const real = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(real.getTime()) && real.toISOString().startsWith(iso) ? iso : null;
}

function slotFromForm(form) {
  const { date: dateText, start, end, room } = Object.fromEntries(new FormData(form));
  if (!dateText || !start || !end || !room.trim()) return { problem: 'Date, start, end and room are all required.' };
  const date = parseDisplayDate(dateText);
  if (!date) return { problem: 'Enter the date as DD/MM/YYYY.' };
  if (end <= start) return { problem: 'The end time must be after the start time.' };
  return {
    slot: {
      start_time: zonedToIso(date, start),
      end_time: zonedToIso(date, end),
      room: room.trim(),
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
  if (problem || !form.condition.value) {
    showError($('admin-error'), problem ?? 'Choose a condition: it sets how many people can book the slot.');
    scrollTo(0, 0);
    return;
  }
  if (await write(sb.from('slots').insert({ ...slot, condition: form.condition.value }))) {
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
    condition: s.condition,
  }));
}

function deleteSlot(slot) {
  const held = slot.signups.length;
  const unsent = slot.signups.some((s) => s.session_cancelled_at && !s.cancellation_sent_at);
  const warning = held
    ? `Delete this slot and the ${held} sign-up record(s) in it? Participants are not notified.${unsent ? ' Cancellation emails that have not gone out yet will be lost.' : ''}`
    : 'Delete this slot?';
  if (confirm(warning)) write(sb.from('slots').delete().eq('id', slot.id));
}

function seatHolders(slot) {
  return slot.signups.filter((s) => s.status === 'booked' || s.status === 'confirmed');
}

function cancelSession(slot) {
  const holders = seatHolders(slot).length;
  const warning = holders
    ? `Cancel this session? ${holders} participant(s) will be emailed that it is cancelled, and it leaves the public list.`
    : 'Cancel this session? It has no participants to email, and it leaves the public list.';
  if (confirm(warning)) write(sb.rpc('cancel_session', { p_slot_id: slot.id }));
}

function waitingList(slot) {
  return slot.signups
    .filter((s) => s.status === 'booked')
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

function openPlaces(slot) {
  return Math.max(0, slot.capacity - seatsTaken(slot));
}

// First come, first invited, until the researcher ticks someone else.
function invitees(slot) {
  const chosen = state.invites.get(slot.id);
  const waiting = waitingList(slot);
  return chosen ? waiting.filter((s) => chosen.has(s.id)) : waiting.slice(0, openPlaces(slot));
}

function toggleInvite(slot, signupId) {
  const chosen = new Set(invitees(slot).map((s) => s.id));
  if (!chosen.delete(signupId)) chosen.add(signupId);
  state.invites.set(slot.id, chosen);
  render();
}

async function confirmSession(slot) {
  const invited = invitees(slot);
  const names = invited.map((s) => s.first_name).join(', ');
  if (!confirm(`Invite ${names}? They will be emailed that the session is confirmed, and their other sign-ups are released.`)) return;
  const saved = await write(
    sb.rpc('confirm_session', { p_slot_id: slot.id, p_signup_ids: invited.map((s) => s.id) }),
    'Someone you selected is already confirmed for another session.');
  if (saved) {
    state.invites.delete(slot.id);
    render();
  }
}

// --- Roster ---

function remindedBadge(signup) {
  return signup.reminded_at && h('span', { className: 'badge mono' }, `REMINDED ${fmtDay(signup.reminded_at)}`);
}

function seatsTaken(slot) {
  return slot.signups.filter((s) => SEAT_TAKEN.has(s.status)).length;
}

function otherSignups(signup, slot) {
  return state.slots
    .filter((s) => s.id !== slot.id)
    .flatMap((s) => s.signups)
    .filter((s) => s.status === 'booked' && s.email.toLowerCase() === signup.email.toLowerCase())
    .length;
}

function participantRow(signup, slot) {
  // Someone without a seat cannot be put back into a full slot.
  const noSeatFree = !SEAT_TAKEN.has(signup.status) && seatsTaken(slot) >= slot.capacity;
  const setStatus = (status) => write(
    sb.from('signups').update({ status }).eq('id', signup.id),
    'This person already has another active booking or has taken part already.');

  return h('li', { className: `participant status-${signup.status}` },
    h('div', { className: 'participant-info' },
      signup.status === 'booked' && openPlaces(slot) > 0 && Date.parse(slot.start_time) > Date.now()
        && h('label', { className: 'check inline' },
          h('input', {
            type: 'checkbox',
            checked: invitees(slot).some((s) => s.id === signup.id),
            onchange: () => toggleInvite(slot, signup.id),
          }),
          h('span', {}, 'Invite')),
      h('strong', {}, signup.first_name),
      h('span', { className: 'email' }, signup.email),
      signup.status !== 'booked' && h('span', { className: 'badge mono' }, signup.status.replace('_', '-').toUpperCase()),
      signup.session_confirmed_at
        && h('span', { className: 'badge mono' }, signup.session_confirmation_sent_at ? 'CONFIRMATION EMAILED' : 'CONFIRMATION EMAIL PENDING'),
      remindedBadge(signup),
      signup.status === 'booked' && otherSignups(signup, slot) > 0
        && h('span', { className: 'badge mono' }, `ALSO IN ${otherSignups(signup, slot)} OTHER`),
      signup.released_at && h('span', { className: 'badge mono' }, 'RELEASED: IN ANOTHER SESSION'),
      signup.status === 'cancelled' && signup.session_cancelled_at
        && h('span', { className: 'badge mono' }, signup.cancellation_sent_at ? 'CANCELLATION EMAILED' : 'CANCELLATION EMAIL PENDING')),
    h('div', { className: 'participant-actions' },
      STATUS_ACTIONS.map(([status, label]) => h('button', {
        type: 'button',
        className: 'button small',
        disabled: signup.status === status || (noSeatFree && SEAT_TAKEN.has(status)),
        onclick: () => setStatus(status),
      }, label))));
}

function walkInRow(slot) {
  const error = h('p', { className: 'error', role: 'alert', hidden: true });

  const submit = async (event) => {
    event.preventDefault();
    const form = event.target;
    const firstName = form.first_name.value.trim();
    const email = form.email.value.trim().toLowerCase();
    if (!firstName || !email || !form.email.checkValidity()) {
      showError(error, 'Enter a name and a valid email.');
      return;
    }
    const saved = await write(
      sb.from('signups').insert({ slot_id: slot.id, first_name: firstName, email, status: 'confirmed' }),
      'This email already has an active booking or has taken part already.');
    if (saved) {
      state.walkInFor = null;
      render();
    }
  };

  return h('form', { className: 'walkin', noValidate: true, onsubmit: submit },
    h('input', { name: 'first_name', placeholder: 'First name', 'aria-label': 'First name' }),
    h('input', { name: 'email', type: 'email', placeholder: 'Email', 'aria-label': 'Email' }),
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
      h('label', { className: 'field' }, 'Date ', h('input', { name: 'date', inputMode: 'numeric', autocomplete: 'off', placeholder: 'DD/MM/YYYY', value: displayDate(date) })),
      h('label', { className: 'field' }, 'Start ', h('input', { name: 'start', type: 'time', value: start })),
      h('label', { className: 'field' }, 'End ', h('input', { name: 'end', type: 'time', value: end })),
      h('label', { className: 'field' }, 'Room ', h('input', { name: 'room', value: slot.room }))),
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
  const seats = seatsTaken(slot);
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
    value: slot.condition,
    onchange: (event) => write(sb.from('slots').update({ condition: event.target.value }).eq('id', slot.id)),
  }, h('option', { value: '2P' }, 'HHR'), h('option', { value: '3P' }, 'HHH'));

  return h('article', { className: `slot${running ? ' running' : ''}${slot.is_active ? '' : ' inactive'}${isGroupComplete(slot) ? ' completed' : ''}` },
    h('header', { className: 'slot-head' },
      h('div', { className: 'slot-title' },
        h('span', { className: 'mono strong' }, fmtRange(slot.start_time, slot.end_time)),
        h('span', {}, slot.room),
        h('span', { className: 'badge mono' }, `${seatHolders(slot).length}/${SIGNUP_LIMIT} SIGNED UP`),
        h('span', { className: `badge mono${full ? ' solid' : ''}` }, `${seats}/${slot.capacity} INVITED`),
        running && h('span', { className: 'badge mono solid' }, 'NOW'),
        !slot.is_active && h('span', { className: 'badge mono' }, 'CLOSED')),
      h('div', { className: 'button-row' },
        Date.parse(slot.start_time) > now && !full && waitingList(slot).length > 0 && h('button', {
          className: 'button primary small',
          type: 'button',
          disabled: invitees(slot).length !== openPlaces(slot),
          title: invitees(slot).length !== openPlaces(slot) ? `Tick exactly ${openPlaces(slot)} to invite.` : '',
          onclick: () => confirmSession(slot),
        }, `Send confirmation email (${invitees(slot).length}/${openPlaces(slot)})`),
        h('button', {
          className: 'button small',
          type: 'button',
          onclick: () => { state.editing = state.editing === slot.id ? null : slot.id; render(); },
        }, 'Edit'),
        // A cancelled session is closed and holds nobody, so there is nothing left to cancel.
        Date.parse(slot.start_time) > now && (slot.is_active || seatHolders(slot).length > 0)
          && h('button', { className: 'button small', type: 'button', onclick: () => cancelSession(slot) }, 'Cancel session'),
        h('button', { className: 'button small', type: 'button', onclick: () => deleteSlot(slot) }, 'Delete'))),

    state.editing === slot.id && editForm(slot),
    slot.notes && state.editing !== slot.id && h('p', { className: 'slot-notes' }, slot.notes),

    h('div', { className: 'group-row' },
      h('label', {}, 'Group ID ', groupInput),
      h('label', {}, 'Condition ', conditionSelect)),

    signups.length
      ? h('ul', { className: 'participants' }, signups.map((signup) => participantRow(signup, slot)))
      : h('p', { className: 'empty' }, 'No sign-ups yet.'),

    !full && (state.walkInFor === slot.id
      ? walkInRow(slot)
      : h('button', {
        className: 'button small',
        type: 'button',
        onclick: () => {
          state.walkInFor = slot.id;
          render();
          document.querySelector('.walkin input').focus();
        },
      }, '+ Add participant')));
}

function renderRoster() {
  const now = Date.now();
  const visible = state.slots.filter((s) => state.showPast || Date.parse(s.end_time) > now);
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
  addForm.date.value = displayDate(localParts(new Date())[0]);
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
