# Feature Specification: Account Removal and Call Runtime Hardening

## Requirements

- Removing a Facebook account stops the complete managed Chrome process tree before deleting CRM data.
- A late extension reconnect from a removed account must not recreate that account.
- One CRM call action may click Facebook's call control only once.
- Repeated call trigger events within a short interval must be rejected.
- Duplicate incoming ringing events must produce one CRM notification.
- Managed background Chrome profiles must not show native Facebook notifications; CRM owns call presentation.
- The packaged installer and portable `win-unpacked` output must contain the embedded runtime configuration.

## Success criteria

- Deleted accounts remain deleted after their former Chrome process exits/reconnects.
- A single call action creates at most one Messenger call window.
- One incoming call produces one CRM call popup.
- Both installer and `win-unpacked` start with campaign/runtime flags enabled.
