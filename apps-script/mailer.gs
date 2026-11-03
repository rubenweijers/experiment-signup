// Sends sign-up emails, session confirmations and reminders from the study's Gmail account.
// Paste into a Google Apps Script project; setup is in docs/README.md, step 6.
// Apps Script cannot import docs/config.js, so keep these values in step with it.
const SUPABASE_URL = 'https://ggewamsgudwvpwhtzxdy.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdnZXdhbXNndWR3dnB3aHR6eGR5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM2MTc5MzUsImV4cCI6MjEwOTE5MzkzNX0.wszEXKwDFjvdpEQRDXFFHqj1yEkccpbPJYdqw3SXoq8';
const SITE_URL = 'https://rubenweijers.github.io/experiment-signup/';
const STUDY_TITLE = 'Group Design Experiment';
const DURATION_LABEL = '~60 mins';
const COMPENSATION_LABEL = '€20 in cash';
const LOCATION_LABEL = 'Room 4B-280 (Product Evaluation Lab): IDE, Building 32, TU Delft';
const CONTACT_EMAIL = 'r.weijers@tudelft.nl';
const TIMEZONE = 'Europe/Amsterdam';
const MAP_URL = `${SITE_URL}map_with_arrow.png`;
const MAP_HTML = '<br><br>Find the room on this map:<br><img src="cid:map" alt="Floor plan of the 4th floor with the room circled" width="600" style="max-width:100%;height:auto">';
const SIGNATURE = 'With kind regards,\n\nRuben Weijers\nPhD candidate, TU Delft';

function rpc(name, params) {
  const response = UrlFetchApp.fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'post',
    contentType: 'application/json',
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
    payload: JSON.stringify(params),
  });
  return response.getContentText() ? JSON.parse(response.getContentText()) : null;
}

function sessionLine(signup) {
  const start = new Date(signup.start_time);
  const end = new Date(signup.end_time);
  const day = Utilities.formatDate(start, TIMEZONE, 'EEEE d MMMM');
  return `${day}, ${Utilities.formatDate(start, TIMEZONE, 'HH:mm')} - ${Utilities.formatDate(end, TIMEZONE, 'HH:mm')}`;
}

function appointmentLines(signup) {
  const start = new Date(signup.start_time);
  const end = new Date(signup.end_time);
  return [
    `Date: ${Utilities.formatDate(start, TIMEZONE, 'EEEE d MMMM')}`,
    `Time: ${Utilities.formatDate(start, TIMEZONE, 'HH:mm')} - ${Utilities.formatDate(end, TIMEZONE, 'HH:mm')}`,
    `Location: ${LOCATION_LABEL}`,
  ];
}

function cancelLink(signup) {
  return `${SITE_URL}?cancel=${signup.cancel_token}`;
}

// One email for everything a person signed up for, so it holds only what they need now.
// The session confirmation carries the location, duration and compensation.
function buildSignupEmail(group) {
  const [signup] = group;
  return {
    subject: `Sign-up received: ${STUDY_TITLE}`,
    body: [
      `Hi ${signup.first_name},`,
      '',
      `Thanks for signing up for the ${STUDY_TITLE}. This is not a confirmation yet.`,
      '',
      'You signed up for:',
      ...group.map((s) => `- ${sessionLine(s)} (cancel: ${cancelLink(s)})`),
      '',
      'Each session has limited places and needs a full group. We will email you if you have a place, so please keep these times free until then.',
    ].join('\n'),
  };
}

function buildEmail(signup) {
  if (signup.kind === 'session_cancelled') {
    return {
      subject: `Session cancelled: ${STUDY_TITLE}`,
      body: [
        `Hi ${signup.first_name},`,
        '',
        `Unfortunately, your session for the ${STUDY_TITLE} has been cancelled because of a lack of participants for your timeslot.`,
        '',
        ...appointmentLines(signup).slice(0, 2),
        '',
        `If you would still like to take part, you can book another time here: ${SITE_URL}`,
      ].join('\n'),
    };
  }
  if (signup.kind === 'session_confirmed') {
    return {
      subject: `Session confirmed: ${STUDY_TITLE}`,
      body: [
        `Hi ${signup.first_name},`,
        '',
        `Your session for the ${STUDY_TITLE} is confirmed. Any other times you signed up for have been released.`,
        '',
        ...appointmentLines(signup),
        `Duration: ${DURATION_LABEL}`,
        '',
        `You will receive ${COMPENSATION_LABEL} for participating.`,
        '',
        `If you cannot make it, please cancel here: ${cancelLink(signup)}`,
      ].join('\n'),
    };
  }
  if (signup.kind === 'final_reminder') {
    return {
      subject: `Starting soon: ${STUDY_TITLE}`,
      body: [
        `Hi ${signup.first_name},`,
        '',
        `Your session for the ${STUDY_TITLE} starts in about 1 hour.`,
        '',
        ...appointmentLines(signup),
        '',
        `You will receive ${COMPENSATION_LABEL} for participating.`,
        '',
        'See you soon!',
      ].join('\n'),
    };
  }
  return {
    subject: `Reminder: ${STUDY_TITLE}`,
    body: [
      `Hi ${signup.first_name},`,
      '',
      `This is a reminder of your appointment for the ${STUDY_TITLE} tomorrow.`,
      '',
      ...appointmentLines(signup),
      '',
      `You will receive ${COMPENSATION_LABEL} for participating.`,
      '',
      `If you cannot make it, please cancel here: ${cancelLink(signup)}`,
    ].join('\n'),
  };
}

// The HTML version of a body, with the URL behind the word 'here'. The first name comes from a public form, so it is escaped.
function toHtml(body, group) {
  let html = body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  for (const signup of group) {
    const link = signup.kind === 'session_cancelled' ? SITE_URL : cancelLink(signup);
    html = html
      .replace(`here: ${link}`, `<a href="${link}">here</a>.`)
      .replace(`cancel: ${link}`, `<a href="${link}">cancel</a>`);
  }
  return html.replace(/\n/g, '<br>');
}

// Everyone with a session to attend gets the map; a sign-up is not one yet.
function hasMap(signup) {
  return signup.kind !== 'session_cancelled' && signup.kind !== 'confirmation';
}

// The mailer reads all of one person's sign-up emails in one run, because a booking saves them together.
function groupEmails(pending) {
  const groups = new Map();
  for (const signup of pending) {
    const key = signup.kind === 'confirmation' ? signup.email.toLowerCase() : signup.id;
    groups.set(key, [...(groups.get(key) ?? []), signup]);
  }
  return [...groups.values()];
}

// Embedded rather than linked, because mail clients often hide remote images.
// A missing map must not hold up a booking email, so the email then goes out without it.
function fetchMap() {
  try {
    return UrlFetchApp.fetch(MAP_URL).getBlob().setName('map_with_arrow.png');
  } catch (error) {
    console.warn(`Could not fetch the map: ${error.message}`);
    return null;
  }
}

// An email counts as sent only after it goes out, so anything unsent is retried on the next run.
// Logs carry the signup id only, so participant details stay out of the execution log.
function runMailer() {
  const secret = PropertiesService.getScriptProperties().getProperty('MAILER_SECRET');
  const failed = [];
  const pending = rpc('get_pending_emails', { p_secret: secret });
  const map = pending.some(hasMap) ? fetchMap() : null;
  for (const group of groupEmails(pending)) {
    const [signup] = group;
    if (MailApp.getRemainingDailyQuota() < 1) {
      console.warn('Daily email quota used up; the rest go out once it resets.');
      break;
    }
    const { subject, body } = signup.kind === 'confirmation' ? buildSignupEmail(group) : buildEmail(signup);
    const showMap = map && hasMap(signup);
    try {
      MailApp.sendEmail(signup.email, subject, `${body}\n\n${SIGNATURE}`, {
        htmlBody: `${toHtml(body, group)}${showMap ? MAP_HTML : ''}<br><br>${SIGNATURE.replace(/\n/g, '<br>')}`,
        inlineImages: showMap ? { map } : {},
        name: STUDY_TITLE,
        replyTo: CONTACT_EMAIL,
      });
    } catch (error) {
      console.error(`Could not email signup ${signup.id}: ${error.message}`);
      failed.push(signup.id);
      continue;
    }
    for (const sent of group) rpc('mark_email_sent', { p_secret: secret, p_signup_id: sent.id, p_kind: sent.kind });
  }
  if (failed.length) throw new Error(`Could not send ${failed.length} email(s); see the log.`);
}

// Run once by hand. Re-running replaces the trigger instead of adding a second one.
function installTrigger() {
  ScriptApp.getProjectTriggers().forEach((trigger) => ScriptApp.deleteTrigger(trigger));
  ScriptApp.newTrigger('runMailer').timeBased().everyMinutes(1).create();
}
