# Secure Notes

A notes app built with TypeScript, Express and MongoDB, with a plain HTML, CSS and JavaScript frontend served by Express.

Users can manage private notes, edit their profiles and publish posts. Posts are publicly readable. Admins can manage accounts, read all notes and view users grouped by interest. Admin access to other users' notes is read-only.

## Requirements

- Node.js 24.18.0 and npm 11.x
- Docker with Compose v2 for the local MongoDB 8.0.34 replica set, or an external writable MongoDB replica set

## Local setup

Install dependencies:

```sh
npm ci
```

Copy `.env.example` to `.env`:

```powershell
cp .env.example .env
```

Generate a secret and set it as `JWT_SECRET` in `.env`:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Start the database, create the required indexes and run the app:

```sh
npm run db:up
npm run db:indexes
npm run dev
```

Open [localhost:3000](http://localhost:3000). The health endpoint is `/api/health`.

For an external replica set, skip `db:up` and set `MONGODB_URI` in `.env` to a URI with an explicit application database name. Standalone MongoDB is not supported. Run `db:indexes` before starting the app; startup checks the index inventory.

The Compose database is for local development and persists data in a Docker volume. `npm run db:down` stops it without removing the data. Keep `.env` out of version control; the available settings are listed in [.env.example](.env.example).

## Create an admin

Registration creates regular user accounts. To create an admin, supply `ADMIN_NAME`, `ADMIN_EMAIL` and `ADMIN_PASSWORD` through the process environment, then run `npm run admin:create`. There are no default credentials.


```powershell
$env:ADMIN_NAME = Read-Host 'Admin name'
$env:ADMIN_EMAIL = Read-Host 'Admin email'
$adminPassword = Read-Host 'Admin password' -AsSecureString
$env:ADMIN_PASSWORD = [System.Net.NetworkCredential]::new('', $adminPassword).Password
try {
    npm run admin:create
} finally {
    Remove-Item Env:ADMIN_PASSWORD
}
```

Passwords must be 12-128 characters. To reset credentials and restore admin access for an existing account, use `npm run admin:create -- --recover`. This revokes that account's existing tokens.

## API

All routes below use the `/api` prefix. Send JSON bodies with `Content-Type: application/json`. Protected routes require `Authorization: Bearer <accessToken>`; login returns the token in `data.accessToken`. Registration does not sign you in.

| Method | Route | Access | Purpose / request body |
| --- | --- | --- | --- |
| GET | `/health` | Public | Database readiness |
| POST | `/auth/register` | Public | Create an account: `name`, `email`, `password`, optional `interests` |
| POST | `/auth/login` | Public | Sign in: `email`, `password` |
| GET | `/auth/me` | Signed in | Read your profile |
| PATCH | `/auth/me` | Signed in | Update `name` and/or `interests` |
| GET | `/notes` | Signed in | List your notes |
| POST | `/notes` | Signed in | Create a note: `title`, `content` |
| GET | `/notes/:noteId` | Owner | Read a note |
| PATCH | `/notes/:noteId` | Owner | Update `title` and/or `content` |
| DELETE | `/notes/:noteId` | Owner | Delete a note |
| GET | `/posts` | Public | List posts |
| POST | `/posts` | Signed in | Publish a post: `title`, `body` |
| GET | `/users/:userId/posts` | Public | List an author's posts |
| GET | `/users/:userId/posts/all` | Public | Get all of an author's posts |
| GET | `/admin/users` | Admin | List users |
| POST | `/admin/users` | Admin | Create a user: `name`, `email`, `password`, optional `interests`, `role` |
| GET | `/admin/users/:userId` | Admin | Read a user |
| PATCH | `/admin/users/:userId` | Admin | Update `name`, `email`, `password`, `interests` or `role` |
| DELETE | `/admin/users/:userId` | Admin | Delete a user and their notes and posts |
| GET | `/admin/notes` | Admin | List all notes |
| GET | `/admin/notes/:noteId` | Admin | Read any note |
| GET | `/admin/reports/users-by-interest` | Admin | List interest groups with counts and up to five member previews |
| GET | `/admin/reports/users-by-interest/all` | Admin | Get all interest groups and their complete memberships |

Paginated lists accept `limit` (1-100, default 20) and `cursor`. Responses contain `data` and `pagination: { limit, hasMore, nextCursor }`. Pass `nextCursor` unchanged to the same endpoint to fetch the next page. The `/all` routes return complete results and accept no query parameters.

Other successful responses use `{ "data": ... }`, except deletes, which return `204` with no body. Errors use `{ "error": { "code": "...", "message": "...", "requestId": "..." } }`, with optional validation details. Unknown request fields are rejected. Interests are arrays of strings; roles are `user` or `admin`. Admins cannot delete themselves or change their own role.

## Development commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run the app with file watching |
| `npm run build` | Compile the server to `dist/` |
| `npm start` | Run the compiled server |
| `npm run typecheck` | Check TypeScript types |
| `npm run lint` | Run ESLint |
| `npm test` | Run API and database tests |
| `npm run db:explain` | Generate query execution evidence |
| `npm run db:seed` | Seed a separately configured disposable demo database |
| `npm run auth:benchmark` | Measure password hashing and verification |
