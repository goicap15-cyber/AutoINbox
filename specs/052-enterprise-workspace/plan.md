# Implementation plan

1. Extend local CRM schema with company membership and account assignments.
2. Add an enterprise authorization service and company-management APIs.
3. Scope account, inbox and conversation queries through company membership/assignments.
4. Add Company Admin employee/assignment UI and assigned-account `Sử dụng` flow.
5. Add migration, authorization and build tests.

Central license-server company provisioning is kept compatible with the existing licensed owner. Employee credentials are created locally for this browser host in the MVP.
