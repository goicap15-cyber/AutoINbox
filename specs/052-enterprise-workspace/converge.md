# Convergence report

## Completed

- Migration v30 applied without reducing persisted thread/message rows.
- Existing owners were backfilled as company administrators.
- Company employee creation is synchronized to the central License Server and shares the company license.
- Facebook account assignments are enforced for account, conversation, attachment, send, retry, sync and call paths.
- Company Admin UI can create/delete employees and assign accounts.
- Employee account UI only lists assigned accounts and exposes `Sử dụng` for the stored browser profile.
- Production UI build succeeds.
- Targeted auth, migration, assignment and conversation tests pass (8/8).
- Full persistence suite passes 396/397; the sole failure is the pre-existing platform-dependent Chrome fallback test, which detects installed Windows Chrome instead of expecting literal `google-chrome`.

## Environment limitation

`graphify query` and `graphify update .` could not run because the Graphify CLI is not installed or present on PATH in this workspace.

## Deployment boundary

The MVP assumes employees connect to the same CRM/browser host. Reusing profiles from independent physical client machines requires the centralized browser-worker phase described in the specification.
