# Secure Notes

Phases 1-9 implement and verify the secure notes API and its handwritten browser interface: authentication, profiles, private notes, shared posts, admin user management, read-only admin note views, and the grouped-interest report. The frontend uses plain HTML, CSS, and JavaScript modules served by Express from the same origin. Start with the setup below, then follow the [reviewer walkthrough and verification record](docs/handoff.md).

See [architecture.md](architecture.md) for contracts and [implementation-plan.md](implementation-plan.md) for phased delivery.

## Prerequisites and versions

- Node.js **24.18.0** (24.x LTS; `.nvmrc`), npm **11.x**; development verification uses npm 11.15.0.
- MongoDB **8.0.34**, pinned in Compose and the test harness.
- Docker Engine/Desktop with Docker Compose v2 supporting `up --wait` for the local database. Docker Desktop must be running with Linux containers on Windows. Alternatively use a writable external MongoDB replica set.
- Exact npm dependency versions are recorded in `package.json` and `package-lock.json`; use `npm ci` to reproduce them.

The lint dependency tree temporarily overrides `minimatch` to 11.0.1 to address [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249). Keep the override until upstream lint packages require a patched version; lint and type checks verify compatibility with this project's configuration.

Node release policy: [official releases](https://nodejs.org/en/about/previous-releases). Connection options follow [Mongoose documentation](https://mongoosejs.com/docs/connections.html); the test database is managed with [MongoMemoryReplSet](https://typegoose.github.io/mongodb-memory-server/docs/api/classes/mongo-memory-replset/), which launches actual `mongod` processes, not a database mock.

## Local setup

Run commands from the project root:

```sh
npm ci
```

Copy `.env.example` to `.env` (`Copy-Item .env.example .env` in PowerShell, or `cp .env.example .env` on macOS/Linux). Generate a secret and put the resulting value in `JWT_SECRET` in `.env`:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
npm run db:up
npm run db:indexes
npm run dev
```

Open `http://localhost:3000/`; `GET http://localhost:3000/api/health` returns `{"data":{"status":"ok"}}` only while the connected database is available. Configuration is loaded from `.env` at startup; existing environment variables take precedence. No fallback JWT secret is provided.

Compose starts MongoDB, initializes the `rs0` replica set, and waits until it is a writable primary. Data persists in a named Docker volume. Only loopback port `27017` is published. This unauthenticated MongoDB setup is for local development. `npm run db:down` stops containers and retains the data volume.

The replica-set member advertises `localhost:27017`. The Node application runs on the **host** and uses `directConnection=true` to avoid container/host discovery mismatches. If you change the database port or containerize the application later, update both the replica-set addressing and URI appropriately.

For an external database, skip `db:up` and set `MONGODB_URI` to a dedicated database on a writable replica set, for example an authenticated hosted URI. The URI must include an explicit database name using letters, numbers, underscores or hyphens. `admin`, `local`, and `config` are rejected. Never disable certificate verification. Startup refuses standalone MongoDB or an unavailable database and never opens the HTTP listener first.

## Available commands

| Command | Behavior |
| --- | --- |
| `npm run dev` | Watch TypeScript and serve API/static files |
| `npm run typecheck` | Check application, test, and configuration types |
| `npm run lint` | Run ESLint with zero warnings allowed |
| `npm run build` | Compile server code into `dist/` |
| `npm start` | Run compiled server after a build; also requires valid `.env` and a ready database |
| `npm test` | Run tests once against a temporary real MongoDB replica set |
| `npm run test:watch` | Watch and rerun tests |
| `npm run test:browser` | Run Chromium workflows against the real API and a disposable MongoDB replica set |
| `npm run db:up` | Start local Compose database and wait for primary readiness |
| `npm run db:down` | Stop Compose database, keeping its volume |
| `npm run db:indexes` | Add schema-declared indexes and verify the seven-index inventory |
| `npm run admin:create` | Create an admin using environment credentials; explicitly recover with `-- --recover` |
| `npm run auth:benchmark` | Measure five Argon2id hash/verify pairs without printing credentials |
| `npm run db:seed` | Add repeatable demo fixtures to an explicitly acknowledged disposable demo database |
| `npm run db:explain` | Reproduce ordinary-read, post and interest evidence plus summaries using isolated disposable replica sets |

Automatic model index/collection creation remains disabled. Run `db:indexes` after the replica set is ready and before starting the API, including on a fresh external database. Startup verifies indexes before opening the listener; it never creates or drops them automatically. A missing, incompatible, or unexpected index blocks startup. The command is additive and repeatable, uses model `createIndexes()`, and never calls destructive index synchronization. Resolve duplicate emails or review incompatible/extra indexes explicitly before retrying; the command will not remove them for you.

The complete inventory is three built-in `_id_` indexes plus four custom indexes declared with `schema.index()`: `users_email_unique` (`email: 1`, unique), `users_interests_asc` (`interests: 1`, multikey), `notes_owner_id_desc` (`ownerId: 1, _id: -1`), and `posts_author_id_desc` (`authorId: 1, _id: -1`). Owner/author prefix queries reuse their compound indexes. The interest report uses an indexed range before unwind and filters memberships again after unwind. Selective cursor pages can skip irrelevant users; broad first pages may still favor a collection scan. Grouping and computed sorting remain blocking. Run `npm run db:indexes` before starting an existing deployment to install the new additive index.

Models are bound to an explicit connection through `getModels()`. Email normalization trims and lowercases while preserving dots and plus suffixes. Interests trim, lowercase, reject blanks, deduplicate, and enforce at most ten distinct entries of 1–40 characters. Shared Zod schemas provide the same policy for future HTTP inputs. Model setters and document validation apply it to create/save, `insertMany` (the seed write path), replacement, and ordinary query updates. Query updates always enable validators. Replace the complete interests array; partial array updates, aggregation update pipelines, and `bulkWrite` are deliberately rejected because they can bypass these invariants. Native collection writes bypass Mongoose and are reserved for controlled fixtures, not application or seed writes.

Safe inclusion projections and DTO serializers live in `src/shared/dto.ts`; native aggregation must explicitly use them or construct allowlisted outputs. Password hashes and internal counters are excluded from ordinary model selection, and every DTO omits them. Note summaries omit content. Report preview serialization returns at most five safe users.

Page builders in `src/shared/pagination.ts` validate allowlisted query parameters, return descending ObjectId predicates, and specify a `limit + 1` fetch bound. Owner/author builders include the ownership predicate and bind cursors to that account; callers must use the shared route scopes. `pageFromRows()` trims lookahead and uses the last returned row for the next cursor. Interests instead use normalized string keys in ascending binary order. Cursors are versioned and validate scope, key, canonical base64url, UTF-8, and encoded/decoded size. IDs provide deterministic ordering, approximately insertion order; they do not guarantee exact creation chronology or a snapshot across requests.

## Configuration

| Key | Default / requirement |
| --- | --- |
| `NODE_ENV` | `development`; accepts `development`, `test`, `production` |
| `PORT` | `3000`, integer 1–65535 |
| `MONGODB_URI` | Required, with explicit dedicated database name |
| `JWT_SECRET` | Required, at least 32 characters/bytes; generate randomly as shown above |
| `JWT_ISSUER` / `JWT_AUDIENCE` | `secure-notes` / `secure-notes-web` |
| `JWT_TTL_SECONDS` | `900`, integer 1-3600 |
| `AUTH_LOGIN_LIMIT` / `AUTH_REGISTER_LIMIT` | `20` / `10`, integers 1-1000, attempts per peer per window |
| `AUTH_RATE_WINDOW_MS` | `900000` (15 minutes), integer 1-86400000 |
| `DB_SERVER_SELECTION_TIMEOUT_MS` | `5000`, integer 1–60000 |
| `QUERY_TIMEOUT_MS` / `REPORT_TIMEOUT_MS` | `5000` each, integer 1–60000 |
| `SHUTDOWN_TIMEOUT_MS` | `10000`, integer 1–60000 |
| `LOG_LEVEL` | `info`; standard Pino levels or `silent` |

Invalid configuration reports field names only. Request logs include generated request IDs, methods, matched route patterns, statuses, and elapsed time; they omit request bodies, headers, raw URLs, and queries. Unexpected error messages/stacks are not logged because driver errors can contain credentials. Keep `.env` untracked. CORS is not enabled. JSON bodies are limited to 100 KiB. Helmet supplies security headers and a same-origin CSP.

The API uses the architecture's central error envelope, including `requestId` matching the `X-Request-Id` response header. Unknown API paths return JSON `404`; invalid JSON returns `400`, oversized JSON `413`, unavailable database readiness `503`, and unexpected exceptions a sanitized `500`. Unsupported content encodings return `415`. Graceful `SIGINT`/`SIGTERM` shutdown stops HTTP and closes MongoDB, with a bounded forced-close deadline.

## Browser interface

Open `/` after starting the service. Register each User account, then log in separately. The navigation provides My notes, Profile, and Posts; Admins also see Manage users, All notes, and Interests report. Bootstrap the initial Admin with `npm run admin:create` as described below.

- My notes supports create/open/edit/delete. All notes provides Admin read-only detail views, including for other owners. Admins manage their own notes through My notes.
- Profile edits name and comma-separated interests. Leave interests blank to clear them; the API trims, lowercases, and deduplicates entries. Blank entries between commas are validation errors.
- Posts supports creation and global browsing. Each post's author control opens that author's paginated lookup view; My author page also works before creating any posts.
- Manage users supports creation, detail/edit, role changes, optional password resets, and confirmed account/content deletion. Leaving the reset field blank keeps the password. Self-role and self-delete controls are disabled/omitted; resetting your own password signs you out.
- Every list has page size, Next, and First page / Refresh controls. Mutations return affected lists to their first page. The interest report shows exact counts and at most five preview members per group, with an explicit message when additional members exist.

The UI displays loading, empty, validation, permission, and API-error states, including request IDs when available. Tokens remain only in module memory; logout, session expiry, and authenticated `401` responses clear the token and private view. Reloading requires login again. Pending requests are canceled on view/session changes. User content is rendered with DOM text APIs. The API remains the authority for permissions, including changes to current roles.

To reproduce the browser checks:

```sh
npx playwright install chromium
npm run test:browser
```

The first command installs the browser used by the pinned Playwright development dependency. The suite starts Express on a random loopback port and a disposable real MongoDB 8.0.34 replica set. It ignores application database configuration and uses synthetic accounts, with no preexisting server or credentials required. It checks both roles, registration, profiles, note CRUD/isolation, post creation/author browsing, all six paginated lists, admin CRUD/cascade/reset, bounded report previews, safe text rendering, permission/error/loading states, request cancellation, memory-only login, expiry, and narrow-screen overflow. Reference desktop/mobile screenshots are written under ignored `.cache/browser/`.

## Authentication and profiles

- `POST /api/auth/register` accepts only `name`, `email`, `password`, and optional `interests`. It always creates a User and returns `201` with `{ "data": <safe user> }`; login separately.
- `POST /api/auth/login` accepts only `email` and `password`. It returns `{ "data": { "accessToken": "...", "expiresIn": 900, "user": <safe user> } }`, using the configured TTL. Unknown accounts and incorrect passwords share `401 INVALID_CREDENTIALS`. Unknown accounts still perform Argon2 verification with a dummy hash.
- `GET /api/auth/me` requires `Authorization: Bearer <accessToken>` and returns the current safe user DTO.
- `PATCH /api/auth/me` accepts a nonempty subset of `name` and `interests`. All identity, role, password, and internal-field updates are rejected. These four routes reject unsupported query parameters.

Passwords are 12-128 characters as supplied, with no trimming or truncation. Argon2id uses 19 MiB, two iterations, parallelism one, and a random salt per hash. Normalized-email uniqueness is enforced by MongoDB; concurrent duplicates return a sanitized `409 EMAIL_ALREADY_EXISTS`.

JWTs contain only `sub`, `ver`, `iss`, `aud`, `iat`, and `exp`, signed with HS256. Verification checks the signature, algorithm allowlist, required claims, configured issuer/audience, expiration, issue time/age, bounded lifetime, ObjectId subject, and nonnegative integer version. Tokens belong in the Authorization header; query-string tokens are not accepted. Every protected request loads the account by `_id`, checks its current token version, and uses its current database role. Account deletion or a token-version change invalidates an existing token on its next request. Ordinary users receive `403 FORBIDDEN` on every `/api/admin` path. Admin note read routes, user management, and the interests report are implemented.

Login and registration have independent fixed-window limits (including failed or malformed attempts), keyed by the actual socket peer, before password hashing. A limit returns `429 RATE_LIMITED` and `Retry-After`. Each limiter stores at most 10,000 peers and rejects new peers while full until entries expire. Limits are in-process and reset on restart; this matches the single-process architecture. Express does not trust proxy headers, so clients cannot bypass limits with `X-Forwarded-For`. A reverse proxy therefore shares one peer limit unless a deliberately configured, trusted proxy policy is added.

The browser UI keeps tokens only in memory. There is no refresh-token or server-side logout endpoint. Clearing a browser token does not revoke a copied token before its expiry or version/account invalidation. Use HTTPS outside local development.

## Notes

All note routes require `Authorization: Bearer <accessToken>` and reject unsupported query parameters.

- `POST /api/notes` accepts only `title` and `content`, returning `201` with `{ "data": <note detail> }`. Titles are trimmed to 1-200 characters; content preserves whitespace and accepts 0-20,000 characters. Both fields are required on creation.
- `GET /api/notes` lists only the current account's note summaries, using `limit` and an optional owner-bound `cursor` with the standard pagination envelope. Summaries contain `id`, `ownerId`, `title`, `createdAt`, and `updatedAt`.
- `GET /api/notes/:noteId` returns an owned note with `content`. `PATCH` accepts a nonempty subset of `title` and `content` and returns the updated detail. `DELETE` returns `204` with no body.
- `GET /api/admin/notes` lists all note summaries with a separate cursor scope. `GET /api/admin/notes/:noteId` returns any note's detail. Both require the current Admin role; there are no admin note write handlers.

The server assigns ownership exclusively from the authenticated account. Ordinary detail/update/delete predicates include both `_id` and `ownerId`, including for Admins; updates and deletes are atomic. Missing and inaccessible targets return the same `404 NOTE_NOT_FOUND`. Invalid IDs, empty patches, owner/internal-field injection, and unknown inputs return `400`.

Creation uses the shared `withParentContentWrite()` transaction helper: increment the parent's internal `contentRevision`, then insert the note on the same session, committing or rolling back together. The parent predicate also rechecks the authenticated token version. The shared `withContentTransaction()` wrapper uses Mongoose/driver transaction retries. Account deletion deletes this same parent before cascading, so conflicting transactions retry against the committed parent/children. All operations within each session run sequentially. Post creation uses the same parent fence.

## Posts and Scenario 2

Post reads are public, including anonymous visitors. Creating posts requires a bearer token and is available to either role.

- `POST /api/posts` accepts only required `title` and `body`, returning `201` with a safe post DTO. Titles trim to 1-200 characters; bodies preserve whitespace and accept 1-10,000 characters. The server assigns `authorId` and uses the parent write-fence transaction.
- `GET /api/posts` returns the standard list envelope with descending ObjectId pagination, using the built-in `_id_` index.
- `GET /api/users/:userId/posts` returns the same envelope plus top-level `author: { id, name }`. The cursor is bound to the requested author. Missing authors return `404 USER_NOT_FOUND`; existing authors without posts return `200` with an empty page.
- `GET /api/users/:userId/posts/all` returns `{ data: [<every post>], author: { id, name } }` in descending ObjectId order. It accepts no query parameters and uses exactly one native aggregation with `$lookup`, no preliminary account read, no limit, and no fallback queries. An immediately following `$unwind` allows MongoDB to coalesce lookup/unwind rather than materializing the author's posts in one BSON result document. Missing authors return `404`; empty authors return an empty array. The browser's **Show all author posts** control opens this view.

Both lists accept only `limit` (default 20, range 1-100) and `cursor`. Post DTOs contain `id`, `authorId`, `title`, `body`, `createdAt`, and `updatedAt`. Post editing/deletion and public user profiles are outside this phase.

Each author repository method uses exactly one native `User.collection.aggregate()` call: match the validated ObjectId and join `users._id` to `posts.authorId` with safe projections. The paginated method applies its cursor and lookahead limit inside `$lookup`; the complete method has neither. Both use the outer built-in `_id_` index and foreign `posts_author_id_desc` index. Public reads perform no authentication account query. Application code serializes safe author/post DTOs.

`npm run db:explain` launches disposable MongoDB 8.0.34 replica sets sequentially, installs the seven indexes, writes synthetic fixtures, and saves ordinary-read, post and interest evidence. It ignores application database configuration and shuts down each temporary database afterward. [Read observations](docs/query-evidence/reads.md) cover login, current-account and point reads, all ordinary first/cursor pages and cascade predicates. [Post observations](docs/query-evidence/posts.md) cover actual lookup index/scan statistics and supplemental foreign/global winning plans. [Report observations](docs/query-evidence/interests.md) cover first, cursor, and selective cursor plans, grouping/sort memory, spill behavior, and timings. Each summary links its full sanitized JSON.

## Scenario 1: grouped-interest report

`GET /api/admin/reports/users-by-interest` requires the current Admin role. It accepts only `limit` (default 20, integer 1-100) and an optional report-scoped `cursor`. The standard list envelope contains groups with `interest`, exact `userCount`, `usersPreview: [{ id, name }]`, and `hasMoreUsers`. Previews contain at most five users in descending ObjectId order; `hasMoreUsers` is true when the count exceeds five. Empty interest arrays contribute no groups. Normalized, deduplicated interests ensure each user contributes once to each of their interests.

`GET /api/admin/reports/users-by-interest/all` returns `{ data: [{ interest, userCount, users: [{ id, name }] }] }` with every group and every member. It accepts no query parameters and requires Admin access. One native aggregate performs a leading index-eligible nonempty range, unwind, membership sort, `$group` with `$push`, group sort, and safe projection. It uses no find, distinct, count, populate, or per-group reads. Groups use binary ascending interest order and members use descending ObjectId order. The browser's **Show all groups and members** control opens this view.

Complete responses are intended for datasets that fit server and client memory; no results are silently truncated. Complete interest groups also remain subject to MongoDB's 16 MiB BSON document and aggregation accumulator limits. These failures return `413 REPORT_TOO_LARGE` with a suggestion to use the paginated report; time budget exhaustion returns `503 REPORT_TIMEOUT`. Both modes use `allowDiskUse`, which cannot remove these limits. Both complete endpoints collect the full result in application memory. Use the existing paginated views for large datasets.

The complete author-post endpoint uses `QUERY_TIMEOUT_MS` and returns `503 QUERY_TIMEOUT` if execution or cursor consumption exceeds the server budget. Database error details are not exposed.

The paginated repository makes one `User.collection.aggregate()` invocation: indexed interest range match, unwind, repeated membership range match, count and bounded `$topN` grouping, ascending binary group sort, lookahead limit, and safe projection. It performs no find, distinct, count, populate, second aggregate, or per-group query. Native cursor consumption only consumes that result. The shared current-account authentication lookup is outside both report-data algorithms; this is the architecture's interpretation of the single-aggregate requirement. Responses contain no email, role, password hash, token version, or content revision.

Group cursors use the last returned interest and simple/binary collation. The database fetches at most `limit + 1` groups; application code trims lookahead. Separate requests do not share a snapshot, so interest edits can change memberships between pages. The aggregate uses `REPORT_TIMEOUT_MS`, `allowDiskUse: true`, and returns `503 REPORT_TIMEOUT` if MongoDB exhausts the execution budget. Pagination and bounded previews limit output; the report still processes all remaining memberships and can require significant grouping memory. The indexed leading range excludes users without any interests after the cursor; the repeated post-unwind range excludes their earlier memberships. Exact counts are preserved. Disk-use permission does not remove aggregation limits.

## Admin user management and account deletion

Every `/api/admin/users` route requires a bearer token and the current database Admin role. All responses use safe user DTOs; passwords, hashes, token versions, and content revisions never appear.

- `GET /api/admin/users` accepts only `limit` and `cursor`, returning the standard paginated envelope in descending ObjectId order. It supports no filtering or alternate sorting.
- `POST /api/admin/users` requires `name`, `email`, and `password`; optional `interests` defaults to `[]`, and optional `role` defaults to `user`. Role accepts only `user` or `admin`. It shares registration's normalization and validation and returns `201` with `{ "data": <user> }`.
- `GET /api/admin/users/:userId` returns a single safe user. Missing accounts return `404 USER_NOT_FOUND`.
- `PATCH /api/admin/users/:userId` accepts a nonempty subset of `name`, `email`, `interests`, `role`, and `password`. Password resets hash the exact supplied password before the atomic update and increment `tokenVersion` in that same write. Existing JWTs fail on their next request; role changes also take effect on the next request. Duplicate normalized emails return `409 EMAIL_ALREADY_EXISTS`, leaving the entire update unchanged.
- `DELETE /api/admin/users/:userId` deletes the target account, its notes, and its posts in a transaction, returning `204` without a body. Missing targets return `404 USER_NOT_FOUND`. A failure rolls back all three collections; unexpected failures return a sanitized `500`, and recognized database connectivity failures return `503`.

Self-deletion and any `role` assignment to the caller's own account (including reassigning the same role) return `409 SELF_ACCOUNT_OPERATION` before writing. Other allowed self updates work; resetting your own password also revokes your current token. These safeguards do not prevent coordinated admins from removing each other's access; use the explicit bootstrap recovery command when needed.

Deletion first deletes the parent within the transaction, then deletes notes by `ownerId`, then posts by `authorId` on the same session. This conflicts with fenced child creation. If creation commits first, deletion retries and removes its children; if deletion commits first, creation retries and rejects the missing parent. The tests verify both overlapping commit orders and actual transaction retries, plus rollback after all three deletes. Phase 6 also verifies concurrent post creation and account deletion through their actual HTTP endpoints. No indexes were added: user paging/detail reuse `_id_`, and cascades reuse the existing owner/author compound index prefixes.

## First admin and explicit recovery

`admin:create` uses the normal validated database configuration and hashes credentials only after ensuring indexes are installed. Supply `ADMIN_NAME`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD` through the process environment; there are no default credentials, password arguments, or credential output. For PowerShell, read the password without echoing it:

```powershell
$env:ADMIN_NAME = Read-Host 'Admin name'
$env:ADMIN_EMAIL = Read-Host 'Admin email'
$adminSecurePassword = Read-Host 'Admin password' -AsSecureString
$env:ADMIN_PASSWORD = [System.Net.NetworkCredential]::new('', $adminSecurePassword).Password
try {
    npm run admin:create
} finally {
    Remove-Item Env:ADMIN_PASSWORD
    $adminSecurePassword.Dispose()
}
```

The command refuses an existing normalized email without altering the account. To explicitly recover an existing account, supply the same environment keys and run `npm run admin:create -- --recover` instead. Recovery sets the provided name/password, promotes the account to Admin, and atomically increments its token version; existing interests remain intact. Recovery refuses a missing account. Neither operation drops indexes or prints passwords/hashes. Use the recovered credentials through the normal login endpoint.

## Password benchmark

The implementation-machine benchmark on Node.js 24.18.0 / Windows x64 measured five hash operations at **47-88 ms** and verifications at **47-51 ms**, including the first sample. See [the recorded samples](docs/password-benchmark.json). These are local observations, not a latency guarantee; rerun `npm run auth:benchmark` on the deployment machine before increasing the cost settings.

## Optional disposable demo fixtures

Use a separate database named `notes_demo` or `notes_demo_<suffix>`. Set `MONGODB_URI` to that database, `NODE_ENV=development`, and `SEED_DATABASE` to the exact database name. The acknowledgement and name restriction prevent an accidental seed into the normal application database. `SEED_PASSWORD` must meet the normal 12-128-character password bounds; no default password or Admin is supplied.

For the local Compose replica set, in PowerShell after configuring `.env`:

```powershell
$env:NODE_ENV = 'development'
$env:MONGODB_URI = 'mongodb://127.0.0.1:27017/notes_demo?replicaSet=rs0&directConnection=true'
$env:SEED_DATABASE = 'notes_demo'
$demoSecurePassword = Read-Host 'Choose a demo password' -AsSecureString
$env:SEED_PASSWORD = [System.Net.NetworkCredential]::new('', $demoSecurePassword).Password
try {
    npm run db:seed
} finally {
    Remove-Item Env:SEED_PASSWORD
    $demoSecurePassword.Dispose()
}
npm run db:indexes
```

Keep the same URI in this shell for `admin:create` (instructions above) and `npm run dev`; a new shell otherwise uses the URI in `.env`. On other shells, provide the same keys through a secret environment input mechanism. The seed command installs/verifies indexes, hashes the supplied password, and commits all fixtures in one transaction. It creates twelve User accounts, `demo01@example.test` through `demo12@example.test`, with seven notes and seven posts each. Eleven share `chess`, each also has two distinct interests; the twelfth has no interests. Thus there are 23 groups, an 11-member preview case, and enough data to page every list with size five. Bootstrap an Admin separately.

Repeated runs retain existing fixture passwords and profile/content edits, add missing fixture records, and retain unrelated data. Supply a valid password on every run; it applies only to newly created accounts. Conflicting fixture IDs/emails fail atomically. Fixed synthetic IDs provide deterministic pagination, not creation chronology. Do not run the seed concurrently with a walkthrough, and never use this disposable dataset for real data.

## Final query evidence and handoff

`npm run db:explain` ignores application database configuration and runs three fixtures sequentially on fresh MongoDB 8.0.34 replica sets. It writes sanitized JSON and matching Markdown summaries under `docs/query-evidence/`: [ordinary reads](docs/query-evidence/reads.md), [author lookup/posts](docs/query-evidence/posts.md), and [interests](docs/query-evidence/interests.md). Each records actual query commands/pipelines, deployed indexes, distributions, examined keys/documents, blocking stages, local timings and available spill/memory observations. No hints or universal latency assertions are used. The [handoff](docs/handoff.md) maps every GET route to its query/index and lists submission files and environment limitations.

## Verification and test isolation

```sh
npm run typecheck
npm run lint
npm run build
npm test
```

The harness starts a single-node **real MongoDB 8.0.34 replica set** using disposable storage. It does not read `MONGODB_URI` or any externally supplied test URI, does not connect to application databases, and does not drop external databases. It creates a random `notes_test_<uuid>` database and verifies its name/URI before connecting. A transaction rollback probe verifies actual transaction support. The harness shuts down its temporary processes and cleans their storage after the run.

The first test requires network access to download MongoDB binaries and enough disk space (the Windows archive is approximately 770 MiB). Package configuration disables the test library's default-version postinstall download; tests download only the pinned version. Subsequent runs reuse the binary cache while creating fresh database storage. Tests fail visibly if download or replica-set startup fails; there is no silent mock or skip fallback. No development `.env`, installed Docker, or already running MongoDB is needed for `npm test`.

Tests cover configuration/secrets, error contracts, body limits, security headers, request logging, static serving, ObjectId/query validation, scope-bound cursors and safe DTOs, real replica-set transactions, startup refusal, standalone rejection, HTTP startup, and database/listener shutdown. The Compose route needs Docker for separate verification; passing the managed-process tests alone does not prove Docker configuration was executed.

## Phase 1 verification result

On the implementation environment, clean `npm ci`, typecheck, lint, build, and all **29 tests** passed with the pinned MongoDB version. The dependency audit reported zero vulnerabilities. Compose YAML and health-check JavaScript were syntax-checked, but Docker is unavailable here, so the Compose startup path still needs execution on a Docker-enabled machine.

## Phase 2 verification result

Typecheck, lint, build, and all **43 tests across five files** passed against the isolated real MongoDB 8.0.34 replica set. Added checks cover model field bounds, normalization on document/query/seed-style writes, duplicate normalized emails, the exact six-index inventory, additive index setup and the actual command, startup refusal for missing indexes, fixed-dataset traversal of all five ordinary list shapes, HTTP `400` cursor errors, and safe ordinary/native projections. No feature endpoints or report/lookup pipelines are claimed in this phase.

## Phase 3 verification result

Typecheck, lint, build, and all **59 tests across seven files** passed against the isolated real MongoDB 8.0.34 replica set. Authentication tests verify actual Argon2id persistence, exact-password verification and length limits, strict input allowlists, concurrent duplicate-email handling, JWT failure cases, current database roles, token-version revocation, deleted accounts, safe profile updates/responses, independent rate limits, bounded limiter storage/expiration, secret-free request logs, and the actual admin command's creation/duplicate/recovery/error paths. The server startup test also confirms the protected auth route is wired into the running HTTP service. The six-index inventory remains unchanged.

## Phase 4 verification result

Typecheck, lint, build, and all **70 tests across eight files** passed against the isolated real MongoDB 8.0.34 replica set. The 11 new note integration tests cover both roles' own CRUD, cross-owner read/mutation denial, current-role admin reads, absence of admin write handlers, authentication, complete paginated traversal, cursor isolation, safe summaries/details, validation bounds and injection attempts, transactional fencing, rollback, revoked/deleted parent checks, and concurrent parent-first deletion without orphan notes. The six-index inventory remains unchanged.

## Phase 5 verification result

Typecheck, lint, build, and all **89 tests across nine files** passed against the isolated real MongoDB 8.0.34 replica set. The 19 new admin/cascade integration tests cover user CRUD, both roles, strict inputs and safe DTOs, pagination and cursor isolation, self-account safeguards, password-reset revocation and concurrent increments, current-role authorization, duplicate-email races and atomic failures, full account/content removal, rollback after all three deletes, sanitized failures, simultaneous deletion, and fenced note/post creation racing with the actual deletion endpoint. Controlled overlapping transactions verify real retries with each side committing first. The six-index inventory remains unchanged.

## Phase 6 verification result

Typecheck, lint, build, and all **99 tests across ten files** passed against the isolated real MongoDB 8.0.34 replica set. Ten new post tests cover both roles, authentication, safe DTOs, strict creation inputs, global/author pagination, missing/empty authors, cursor isolation, single native aggregate execution and bounded lookup structure, transaction rollback, revoked/deleted parents, and HTTP creation/deletion races. The reproducible explain command confirms indexed outer/foreign access on first and cursor pages with no foreign collection scans; supplemental plans confirm indexed ordering. See [the recorded evidence](docs/query-evidence/posts.md). The six-index inventory remains unchanged.

## Phase 7 verification result

Typecheck, lint, build, and all **110 tests across eleven files** passed against the isolated real MongoDB 8.0.34 replica set. Eleven new report tests cover current-role Admin authorization, normalized memberships and profile updates, empty data, exact counts, bounded deterministic previews, safe output, Unicode binary pagination, cursor/query validation, one native aggregate with no fallback queries, configured options, sanitized timeout/database failures, and index inventory. `npm run db:explain` records the intentional scan and blocking group/sort behavior on 12,000 users and 32,400 memberships, including memory, spill observations, and timings. See [report evidence](docs/query-evidence/interests.md). The six-index inventory remains unchanged.

## Phase 8 verification result

At Phase 8, typecheck, lint, build, all **110 existing tests**, and **eight Chromium browser checks** passed. The browser suite exercises the handwritten interface against the real API and isolated MongoDB, including both roles, all six pageable views, CRUD/profile/post workflows, account cascade and token invalidation, current-role handling, error recovery, safe text rendering, reload/logout/expiry, and pending-request cancellation. Desktop/mobile screenshots were inspected and the mobile overflow check passed. See the Browser interface section for reproduction commands and the Phase 9 record below for final verification.

## Phase 9 verification result

Clean `npm ci` (zero audit findings), typecheck, lint, build, **115 API/database tests across twelve files**, and **eight Chromium checks** passed on Node.js 24.18.0 / npm 11.15.0 / MongoDB 8.0.34. A compiled-server smoke check ran the actual index, Admin and seed commands on a fresh disposable replica set, then verified health, static serving, login and the seeded bounded report. Desktop/mobile browser screenshots were inspected again. The final submission text scan found no token/private-key patterns or prohibited sensitive-file paths; synthetic test-only credentials remain in tests.

The seed command and all read/aggregation evidence are implemented. Every GET/list path and both aggregation constraints are reviewed in [the handoff](docs/handoff.md). Compose startup and a live manual browser spot check remain unverified because Docker and the computer-use browser host are unavailable here. Automated Chromium workflows passed against the real API. There is no Git repository in this workspace, so the included dependency lockfile has not been committed.

## Interest report optimization (2026-11-06)

Added `users_interests_asc` and moved the cursor range before grouping, with a leading indexed user filter and a post-unwind membership filter. The earlier phase verification entries and the committed explain files describe the previous six-index implementation. They are not validation of this revision. Re-run `npm test` and `npm run db:explain` in an environment that permits MongoDB subprocesses to regenerate current measurements. No forced index hints are used.

### Complete aggregation views and public posts

Added complete-result endpoints and browser controls while keeping the existing paginated contracts. Post reads are now public; creation retains current-account authentication and transactional ownership checks. Explain tooling now measures both complete pipelines as well as the existing first/cursor cases. The historical committed explain files do not validate these additions. Regenerate them with `npm run db:explain` and run the API/database and browser suites in an environment that permits subprocesses.

Typecheck, lint and compilation passed for this revision. A compiled HTTP/service smoke with stubbed database results passed public complete reads, protected creation/report access, query validation, empty/missing authors, full membership serialization, one aggregate invocation, and sanitized error mapping. It does not establish MongoDB execution correctness. The targeted Vitest integration run failed before collecting tests because process spawning is denied (`spawn EPERM`). New database tests include foreign index usage, complete results beyond the page maximum, and an author dataset exceeding 16 MiB in combined post bodies; the new browser test covers anonymous browsing and both complete-result controls. These database/browser tests and regenerated explain measurements remain unverified in this environment.

Current local validation: typecheck, lint, production build, and 23 shared/pagination tests passed. The focused tests ran with a temporary native-loader, thread-pool config without database setup. Full integration tests failed during MongoDB startup (`spawn EPERM`); `npm run db:explain` was also blocked by subprocess permissions. The two new database regression tests remain unexecuted here.
