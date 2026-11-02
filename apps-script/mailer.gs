// Sends booking confirmations and reminders from the study's Gmail account.
// Paste into a Google Apps Script project; setup is in docs/README.md, step 6.
// Apps Script cannot import docs/config.js, so keep these values in step with it.
const SUPABASE_URL = 'https://ggewamsgudwvpwhtzxdy.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdnZXdhbXNndWR3dnB3aHR6eGR5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM2MTc5MzUsImV4cCI6MjEwOTE5MzkzNX0.wszEXKwDFjvdpEQRDXFFHqj1yEkccpbPJYdqw3SXoq8';
const SITE_URL = 'https://rubenweijers.github.io/experiment-signup/';
const STUDY_TITLE = 'Group Design Experiment';
const DURATION_LABEL = '~60 mins';
const COMPENSATION_LABEL = '€20 in cash';
const LOCATION_LABEL = 'Room 4B-280: IDE, Building 32, TU Delft';
const CONTACT_EMAIL = 'r.weijers@tudelft.nl';
const TIMEZONE = 'Europe/Amsterdam';

function rpc(name, params) {
  const response = UrlFetchApp.fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'post',
    contentType: 'application/json',
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
    payload: JSON.stringify(params),
  });
  return response.getContentText() ? JSON.parse(response.getContentText()) : null;
}

function appointmentLines(signup) {
  const start = new Date(signup.start_time);
  const end = new Date(signup.end_time);
  return [
    `Date: ${Utilities.formatDate(start, TIMEZONE, 'EEEE d MMMM')}`,
    `Time: ${Utilities.formatDate(start, TIMEZONE, 'HH:mm')} - ${Utilities.formatDate(end, TIMEZONE, 'HH:mm')}`,
    `Room: ${signup.room}`,
    `Location: ${LOCATION_LABEL}`,
  ];
}

// The reminder matches reminderEmailUrl in docs/admin.js.
function buildEmail(signup) {
  const cancelLink = `${SITE_URL}?cancel=${signup.cancel_token}`;
  if (signup.kind === 'confirmation') {
    return {
      subject: `Booking confirmed: ${STUDY_TITLE}`,
      body: [
        `Hi ${signup.first_name}, your appointment for the ${STUDY_TITLE} is booked.`,
        '',
        ...appointmentLines(signup),
        `Duration: ${DURATION_LABEL}`,
        '',
        `You will receive ${COMPENSATION_LABEL} for taking part.`,
        '',
        `If you cannot make it, please cancel here: ${cancelLink}`,
        'Opening the link only asks you to confirm, so nothing is cancelled until you do.',
      ].join('\n'),
    };
  }
  return {
    subject: `Reminder: ${STUDY_TITLE}`,
    body: [
      `Hi ${signup.first_name}, this is a reminder of your appointment for the ${STUDY_TITLE}.`,
      '',
      ...appointmentLines(signup),
      '',
      `You will receive ${COMPENSATION_LABEL} for taking part.`,
      '',
      'Please reply YES to confirm you are coming.',
      `If you cannot make it, please cancel here: ${cancelLink}`,
    ].join('\n'),
  };
}

// An email counts as sent only after it goes out, so anything unsent is retried on the next run.
// Logs carry the signup id only, so participant details stay out of the execution log.
function runMailer() {
  const secret = PropertiesService.getScriptProperties().getProperty('MAILER_SECRET');
  const failed = [];
  for (const signup of rpc('get_pending_emails', { p_secret: secret })) {
    if (MailApp.getRemainingDailyQuota() < 1) {
      console.warn('Daily email quota used up; the rest go out once it resets.');
      break;
    }
    const { subject, body } = buildEmail(signup);
    try {
      MailApp.sendEmail(signup.email, subject, body, { name: STUDY_TITLE, replyTo: CONTACT_EMAIL });
    } catch (error) {
      console.error(`Could not email signup ${signup.id}: ${error.message}`);
      failed.push(signup.id);
      continue;
    }
    rpc('mark_email_sent', { p_secret: secret, p_signup_id: signup.id, p_kind: signup.kind });
  }
  if (failed.length) throw new Error(`Could not send ${failed.length} email(s); see the log.`);
}

// Run once by hand. Re-running replaces the trigger instead of adding a second one.
function installTrigger() {
  ScriptApp.getProjectTriggers().forEach((trigger) => ScriptApp.deleteTrigger(trigger));
  ScriptApp.newTrigger('runMailer').timeBased().everyMinutes(5).create();
}
