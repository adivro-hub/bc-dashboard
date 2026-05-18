# BC Dashboard — Setup guide

The dashboard works in three modes:

| Mode | When | What it needs |
|---|---|---|
| **Demo** | `index.html` open from disk or Pages | Nothing — bundled sample data |
| **Local upload** | `upload.html` with no `config.js` | Just a browser. Files stay on user's machine. |
| **Shared store** | `upload.html` with `config.js` + signed-in user | A Supabase project (free) + members table. Anonymised data persists server-side so a team can read the same numbers without re-uploading. |

This document walks through enabling the **shared store**. The first two
modes need no setup at all.

---

## 1. Create a Supabase project

1. Go to <https://supabase.com>, sign up (free), click **New project**.
2. Pick a name (e.g. `bc-dashboard`), set a strong database password, pick
   a region close to you.
3. Wait ~2 minutes for the project to provision.

## 2. Run the schema

1. In your Supabase project: **SQL Editor → New query**.
2. Open `db/schema.sql` from this repo, copy everything, paste, **Run**.
3. You should see "Success. No rows returned." Eight tables, two helper
   functions, and the RLS policies are now in place.

## 3. Add members

Still in SQL Editor, run:

```sql
INSERT INTO public.members (email, role) VALUES
  ('you@example.com',    'uploader'),
  ('alice@example.com',  'uploader'),
  ('bob@example.com',    'viewer'),
  ('carol@example.com',  'viewer');
```

* **uploader** — can push new data and read everything.
* **viewer** — read-only.

You can add or change members anytime via SQL Editor or **Table editor →
members**.

## 4. Configure auth redirect URLs

In Supabase: **Authentication → URL Configuration**.

* Set **Site URL** to your production URL (e.g. `https://bc-dashboard.vercel.app`).
* Add any preview URLs (e.g. `http://localhost:8765`) to **Redirect URLs**
  so magic links work when you test locally.

## 5. Wire the dashboard to your project

1. From Supabase: **Project Settings → API**. Copy:
   * `Project URL` (looks like `https://abcdefgh.supabase.co`)
   * `anon public` key

2. In the repo: copy `config.example.js` → `config.js`. Paste the values:

   ```js
   window.BC_CONFIG = {
     SUPABASE_URL:      "https://abcdefgh.supabase.co",
     SUPABASE_ANON_KEY: "eyJ...your key here...",
   };
   ```

   `config.js` is gitignored — your URL/key stay out of the repo.

3. (Local test) start the static server and open `upload.html`:

   ```bash
   python -m http.server 8765
   # then visit http://localhost:8765/upload.html
   ```

   You should see "Sign in to push or load shared data" in the auth bar.

## 6. Deploy to Vercel

1. Push this repo to GitHub.
2. On Vercel: **New Project → import this repo**.
3. **No build step needed** — it's a static site. Vercel auto-detects.
4. After the first deploy, add `config.js` to the project:
   * Easiest: commit `config.js` to a private branch you deploy from.
   * Or: use Vercel's **Environment Variables** + a build step to write
     `config.js` from env vars (not required for now — the anon key is
     public anyway, security comes from Supabase RLS).
5. Go to your Vercel URL → `upload.html` → sign in with your email →
   click the magic link → push the first batch of files.

## 7. Use it

* **Upload your reports** (`upload.html`):
  1. Sign in (if not already).
  2. Drop your Excel files into the single drop zone.
  3. Click **Generate dashboard** to see your in-browser view.
  4. Click **Push to shared store** to make this data available to the team.
* **View the shared data**:
  1. Sign in.
  2. Click **Load shared data** in the auth bar.
  3. Pick any date ranges to compare.

## What gets stored server-side (anonymisation)

Anonymisation happens **in your browser before the data leaves your
machine**. The server never sees:

* Passenger names, emails, phone numbers (passenger phone is hashed
  one-way; the hash lets us count unique retail clients without storing
  the phone itself).
* Driver names, emails, phone numbers.
* Vehicle registration plates (hashed).
* Full pickup / drop-off addresses (replaced by two booleans:
  `is_otp_pickup`, `is_otp_dropoff`).
* Free-text cancel reasons (replaced by `is_no_supply_cancel` boolean).

What it does see: account number (corporate), account name (corporate;
trading-partner names), service, urgency, status, dates, hour, totals,
driver totals, response times.

## Common issues

* **"Not a member" after sign-in** — your email isn't in the `members`
  table. Add it via SQL Editor.
* **Magic link redirects to the wrong URL** — add that URL to
  Authentication → URL Configuration → Redirect URLs.
* **Local-only mode after copying `config.js`** — make sure the file is
  reachable by the browser (check the network tab; you should see
  `config.js` 200).
