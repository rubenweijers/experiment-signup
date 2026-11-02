# Experiment sign-up: 5-minute setup

Public booking page (`index.html`) and researcher dashboard (`admin.html`), hosted on GitHub Pages with Supabase behind them. No build step.

## 1. Create the database

1. Create a project at [supabase.com](https://supabase.com) and choose the **Central EU (Frankfurt)** region. The region cannot be changed later.
2. Open **SQL Editor**, paste all of [`../supabase/schema.sql`](../supabase/schema.sql) and click **Run**. You can safely run it again.

## 2. Close public registration

Go to **Authentication → Sign In / Providers** and turn off **Allow new users to sign up**. Nobody except the researcher needs an account.

## 3. Create the researcher account

1. Go to **Authentication → Users → Add user → Create new user**. Enter an email and a strong password, and tick **Auto Confirm User**.
2. In the **SQL Editor**, put that account on the allowlist. Without this step, the dashboard refuses the login:

   ```sql
   insert into public.admin_users (user_id)
   select id from auth.users where email = 'you@university.example'
   on conflict do nothing;
   ```

## 4. Fill in `docs/config.js`

| Setting | Value |
| --- | --- |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | **Project Settings → API**. Use the anon/publishable key, never `service_role` or a secret key. |
| `LOCATION_LABEL`, `DURATION_LABEL`, `CONTACT_EMAIL`, `DEFAULT_ROOM` | Your real building, session length, contact address and room. |
| `STUDY_TITLE` | Keep it neutral: it must not reveal the conditions. |

## 5. Publish

1. Push this repository to GitHub.
2. Go to **Settings → Pages → Deploy from a branch**, choose `main` and `/docs`, and save.
3. Add your Pages address under Supabase **Authentication → URL Configuration → Site URL**.
4. Add the repository secrets `SUPABASE_URL` and `SUPABASE_ANON_KEY` under **Settings → Secrets and variables → Actions**.
5. Under **Actions → Supabase keep-alive**, click **Run workflow** once to check that it passes.

The flyer QR code points to `https://<user>.github.io/<repo>/`. The dashboard is at `.../admin.html`.

GitHub turns off scheduled workflows after 60 days without repository activity. It emails you first; click **Enable workflow** if that happens.

## Running the study

- **Slots:** choose a condition when you add a slot, then copy a whole day with **Duplicate day to next week**. Copies keep room and condition, but not Group ID or notes.
- **Condition sets the seats:** a `2P` slot takes exactly 2 people and a `3P` slot exactly 3. There is no overbooking, and the public page never shows which is which. Changing a slot's condition does not remove anyone already in it.
- **Group ID:** one slot holds one group. Set the anonymous Group ID on the slot card.
- **Quota:** a group counts once its slot has all its seats marked **Completed** (2 for `2P`, 3 for `3P`).
- **Seats:** only `booked` and `confirmed` hold a public seat. A slot leaves the public list when full and returns when someone cancels.
- **One participation per person:** an email address cannot book while it has a `booked`, `confirmed` or `completed` record. People who cancelled or were marked no-show can book again. Someone using a different address can get past this check.
- **Walk-ins:** they are saved as `confirmed` and need a free seat. If someone does not turn up, mark them **No-Show** first; the **+ Add Walk-in** button then appears.
- **Reminders:** the **Reminders** section lists everyone with a session in the next 48 hours (`REMINDER_WINDOW_HOURS`) who is still `booked`. **Email Reminder** opens a draft in your mail app and marks the person as reminded; click **Not Sent** if you close the draft without sending. When someone replies YES, click **Confirmed** and they leave the list.
- **Do not store experimental data here.** While contact details exist, the Group ID links people to their group, so treat any dataset using that ID as pseudonymised until the contact details are deleted.

## Deleting contact details

The consent text promises permanent deletion when the study ends. When data collection is finished, write down the final quota, then run this in the SQL Editor. It cannot be undone, and the quota bars return to zero:

```sql
truncate table public.signups;
```

To delete one participant on request, for example when consent is withdrawn:

```sql
delete from public.signups where email = 'person@university.example';
```

Supabase keeps backups for a limited period after deletion. Check the retention for your plan and state it in your data management plan if required.
