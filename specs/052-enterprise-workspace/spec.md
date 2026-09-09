# Enterprise workspace and Facebook account assignment

## Requirements

- A licensed CRM user can become the administrator of one company workspace.
- A company administrator can create employee login accounts.
- Employees belong to exactly one company and cannot access another company's data.
- A company administrator can assign one or more existing Facebook accounts to employees.
- Employees only see and use assigned Facebook accounts; company administrators see every Facebook account in their company.
- An assigned account appears in account management with a `Sử dụng` action and reuses the browser profile already stored on the CRM browser host.
- Authorization is enforced by server APIs, not only by hidden UI.

## MVP boundary

The browser profiles remain on the current CRM machine. Sharing one profile across separate employee computers requires a future centralized browser-worker deployment.

## Acceptance criteria

1. Company Admin can create, list, block and delete employees.
2. Company Admin can assign and revoke Facebook accounts per employee.
3. Employee login lists only assigned accounts and conversations.
4. Employee can start an assigned stored Facebook profile without manually logging in again on the same browser host.
5. Unauthorized account/thread access returns 404/403.
