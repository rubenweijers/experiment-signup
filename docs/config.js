// Public by design: the anon key is safe in the browser because schema.sql's
// row-level security decides what it can do. Never put the service_role key here.
export const SUPABASE_URL = 'https://ggewamsgudwvpwhtzxdy.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdnZXdhbXNndWR3dnB3aHR6eGR5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM2MTc5MzUsImV4cCI6MjEwOTE5MzkzNX0.wszEXKwDFjvdpEQRDXFFHqj1yEkccpbPJYdqw3SXoq8';

// Shown to participants. Keep the title neutral: it must not reveal a condition.
export const STUDY_TITLE = 'Group Design Experiment';
export const DURATION_LABEL = '~60 mins';
export const COMPENSATION_LABEL = '€20 in cash';
export const LOCATION_LABEL = 'Room 4B-280: IDE, Building 32, TU Delft';
export const CONTACT_EMAIL = 'r.weijers@tudelft.nl';

export const DEFAULT_ROOM = 'Room 4B-280';
export const DEFAULT_SLOT_MINUTES = 60;
export const QUOTA_PER_CONDITION = 25;
export const REMINDER_WINDOW_HOURS = 24;

// All times are shown and entered in the lab's timezone, whatever the viewer's device says.
export const TIMEZONE = 'Europe/Amsterdam';
