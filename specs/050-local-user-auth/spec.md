# Feature Specification: Local CRM User Authentication

## User flow

1. An unauthenticated user first sees the local CRM login/register screen.
2. Login accepts a local CRM username and password without requiring a License Key.
3. Registration creates a `STAFF` user; it never grants `ADMIN`.
4. A successful login creates a revocable, expiring server-side session in an HttpOnly cookie.
5. After authentication, the application checks the workstation License Key.
6. A missing or invalid key opens the activation screen; a valid key opens the CRM.
7. Logout revokes the current session and returns to the authentication screen.

## Security requirements

- Passwords are hashed with bcrypt and are never returned to the client.
- Session tokens are random; only their SHA-256 hashes are stored in SQLite.
- Auth cookies use `HttpOnly`, `SameSite=Strict`, and a bounded lifetime.
- All CRM `/api` routes require both an authenticated user and valid license, except auth/session and license activation endpoints.
- Authentication errors do not reveal whether a username exists.
- Username and password input is length- and format-limited.

## Compatibility

- Existing `admin` users continue to work.
- Thread filters, assignment actions, and campaign ownership use the authenticated user instead of a hard-coded admin.
