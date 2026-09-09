# Implementation Plan: Local CRM User Authentication

1. Add migration v27 for persistent hashed sessions.
2. Add an AuthService for validation, registration, login, session lookup, logout, and middleware.
3. Mount auth/session endpoints before license enforcement, then protect the remaining CRM API with authentication and license checks.
4. Add a combined login/register React screen and logout control.
5. Replace the hard-coded client session user with the authenticated user.
6. Add service/integration tests and run the production UI build.
