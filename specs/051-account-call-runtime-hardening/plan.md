# Implementation Plan

1. Harden managed Chrome termination and removed-account reconnect handling.
2. Remove the synthetic duplicate click and add server-side call trigger cooldown.
3. Deduplicate incoming ringing events and suppress native background notifications.
4. Add focused tests, rebuild, and verify the portable output.
