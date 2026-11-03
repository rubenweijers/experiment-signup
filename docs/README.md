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

## 6. Turn on automatic emails

Confirmations and reminders go out from a dedicated Gmail account, through [`../apps-script/mailer.gs`](../apps-script/mailer.gs). Every minute it fetches who is due, emails them and marks them as sent. Replies go to `CONTACT_EMAIL`.

1. Create the Gmail account and turn on 2-Step Verification. Keep the name neutral: it must not reveal the conditions.
2. Run the current `schema.sql` in the **SQL Editor**, then get the mailer secret: `select secret from public.mailer_secret;`
3. Signed in to that account, open [script.google.com](https://script.google.com) and create a **New project**. Replace the contents of `Code.gs` with `mailer.gs`, and save.
4. Under **Project Settings → Script Properties**, add `MAILER_SECRET` with the secret as its value. Never commit the secret.
5. In the editor, select `installTrigger` and click **Run**. Approve the permissions. Google warns that the app is unverified because it is your own script: choose **Advanced**, then go to the project.

**Before step 5, check who would be emailed.** The first run emails every `booked` person with a future session:

```sql
select su.first_name, su.email, s.start_time
from public.signups su join public.slots s on s.id = su.slot_id
where su.status = 'booked' and su.confirmation_sent_at is null and s.start_time > now();
```

To stop all emails, delete the trigger under **Triggers** in the Apps Script project.

## Running the study

- **Slots:** choose a condition when you add a slot, then copy a whole day with **Duplicate day to next week**. Copies keep room and condition, but not Group ID or notes.
- **Condition sets the seats:** an `HHR` slot takes exactly 2 people and an `HHH` slot exactly 3. The database stores these as `2P` and `3P`. There is no overbooking, and the public page never shows which is which. Changing a slot's condition does not remove anyone already in it.
- **Group ID:** one slot holds one group. Set the anonymous Group ID on the slot card.
- **Quota:** a group counts once its slot has all its seats marked **Completed** (2 for `HHR`, 3 for `HHH`).
- **Seats:** only `booked` and `confirmed` hold a public seat. A slot leaves the public list when full and returns when someone cancels.
- **One participation per person:** an email address cannot book while it has a `booked`, `confirmed` or `completed` record. People who cancelled or were marked no-show can book again. Someone using a different address can get past this check.
- **Adding participants:** they are saved as `confirmed` and need a free seat. If someone does not turn up, mark them **No-Show** first; the **+ Add participant** button then appears.
- **Roster:** it shows sessions that have not ended yet. Tick **Show past sessions** to see earlier ones, for example to mark people **Completed** after a session ends. A slot turns light green once all its seats are **Completed**.
- **Cancelling a session:** **Cancel session** closes the slot, marks everyone holding a seat as cancelled and emails them within about a minute. They can book another slot. Started sessions cannot be cancelled. Wait for **CANCELLATION EMAILED** before deleting the slot, because deleting it loses any email that has not gone out. To open the slot again, use **Edit**; people who were cancelled are not put back.
- **Automatic emails:** each person gets a confirmation within about a minute of booking, a reminder 24 hours before their session, and a short reminder 1 hour before it, which has no cancel link. Someone who books inside 24 hours skips the first reminder, and someone who books inside 1 hour gets only the confirmation. Participants you add yourself get only the session cancellation email. If emails stop arriving, check **Executions** in the Apps Script project. Google accepts mistyped addresses, so a bounce only shows up in the Gmail inbox.
- **Do not store experimental data here.** While contact details exist, the Group ID links people to their group, so treat any dataset using that ID as pseudonymised until the contact details are deleted.

## Deleting contact details

The consent text promises permanent deletion when the study ends. When data collection is finished, write down the final quota, then run this in the SQL Editor. It cannot be undone, and the quota bars return to zero:

```sql
truncate table public.signups;
```

Then delete the Gmail account: its Sent folder and any bounces hold participant addresses and cancellation links, and the script goes with it.

To delete one participant on request, for example when consent is withdrawn:

```sql
delete from public.signups where email = 'person@university.example';
```

Supabase keeps backups for a limited period after deletion. Check the retention for your plan and state it in your data management plan if required.
