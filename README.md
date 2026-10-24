# LINE Accounting Bot MVP

A LINE accounting bot built with Cloudflare Workers and TypeScript. Text messages and receipt photos are parsed by Gemini into a draft stored in Cloudflare KV. A draft is never posted directly: only the matching Flex Message `confirm_draft` postback can start the formal write process.

## Features

- Parse one or multiple expenses from multiline text or receipt photos.
- Use Gemini structured JSON output for amount, item, category, and date extraction.
- Safely evaluate explicit amount expressions such as `306+240`, `1430/2`, and `200-75` without using `eval`.
- Use Taiwan local dates and preserve the exact category names and emojis required by the spreadsheet format.
- Keep one 24-hour pending draft per LINE user, with natural-language edits, re-validation, recalculated totals, preview, and cancellation.
- Verify LINE webhook signatures and deduplicate webhook events.
- Store formal records in both Cloudflare D1 and Google Sheets.
- Track cross-system write states (`pending`, `written`, `failed`, and `unknown`) so the bot does not blindly retry an ambiguous Sheets request.
- Resolve the existing Google Sheet tab from its `gid`, then append only columns A–E with `values.append`.
- Provision a dedicated Google Sheet tab per LINE user. Existing users keep the configured legacy tab; new users receive a `user_xxxxxx` tab on `follow`, or on their first write, query, or sync if no `follow` event was received.
- Query today's total and the totals for each of the last three calendar days.
- Sync the latest three calendar days from Google Sheets back into D1 using sheet row numbers as source keys without deleting existing D1 records.

## Architecture

| Component | Responsibility |
| --- | --- |
| Cloudflare Workers | Webhook handling and orchestration |
| Gemini API | Structured extraction and draft-edit interpretation |
| Cloudflare KV | Pending drafts only; not a source of formal accounting records |
| Cloudflare D1 | Webhook deduplication, batches, formal records, sync state, and query source |
| Google Sheets API | Human-readable A–E append-only ledger and reconciliation source |
| LINE Messaging API | Text/image input, Flex previews, and confirmation postbacks |

## Multi-user Sheet tabs

The `user_sheet_tabs` table maps each LINE user ID to a Google Sheet tab GID. All users share the same D1 database, but accounting queries are filtered by `line_user_id`.

The configured `GOOGLE_SHEET_GID` is used as the legacy/default tab for existing users. New tabs are created with a `user_xxxxxx` title and contain the same five columns:

```text
Write date | Amount | Item | Category | Expense date
```

No F column is added, and existing rows are never overwritten.

## Required services

1. Create or use a Cloudflare D1 database and KV namespace. The resource IDs are configured in `wrangler.toml`.
2. Create a Google Cloud service account, enable the Google Sheets API, and share the spreadsheet with the service-account email as an Editor.
3. Configure the LINE Messaging API webhook URL as `https://<worker-domain>/webhook`.
4. Configure local development credentials with `.env`:

```sh
cp .env.example .env
# Edit .env and replace every placeholder.
```

Do not create `.dev.vars` at the same time as `.env`. `.env` is ignored by Git and must never be committed.

For a deployed Worker, store the same values as Cloudflare secrets:

```sh
wrangler secret put LINE_CHANNEL_SECRET
wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
wrangler secret put GEMINI_API_KEY
wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON
```

`GOOGLE_SERVICE_ACCOUNT_JSON` must contain the complete service-account JSON, including its private key. Never commit it or send it to Gemini. `GOOGLE_SHEET_ID`, `GOOGLE_SHEET_GID`, `GEMINI_MODEL`, and `DRAFT_TTL_SECONDS` are configured in `wrangler.toml`.

## Local development and deployment

```sh
npm install
npx wrangler d1 migrations apply line-accounting --local
npm run typecheck
npm test
npm run dev
```

After the Cloudflare resources and secrets are ready:

```sh
npx wrangler d1 migrations apply line-accounting --remote
npm run deploy
```

The required production secrets are declared in the `[secrets].required` section of `wrangler.toml`.

## Dual-write and recovery semantics

When the user confirms a draft, D1 first creates a unique `draft_id`/`batch_id` and its `expense_records`. The Worker then appends the same rows to Google Sheets. A batch becomes `completed` only after both systems report success, and queries count only records in that completed state.

- A definite Google API rejection becomes `failed` and can be retried with the same confirmation button.
- A timeout or other ambiguous response becomes `unknown`. The Worker does not blindly append again because the five-column sheet has no row-level idempotency key.
- `sheet_response_json`, `sheet_status`, `sheet_updated_range`, batch status, and source keys provide the information needed for reconciliation.

D1 and Google Sheets do not share a transaction. The implementation therefore tracks partial and ambiguous states explicitly instead of claiming cross-system atomicity.

## Security notes

Never upload or commit:

- `.env`, `.dev.vars`, or any real environment file
- LINE channel secrets or access tokens
- Gemini API keys
- Google service-account JSON, private keys, `.pem`, or `.key` files
- `.wrangler/`, `node_modules/`, or local credentials

These patterns are included in `.gitignore`; `.env.example` is the only environment file intended for Git.
