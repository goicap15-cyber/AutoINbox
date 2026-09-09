# Sơ đồ kiến trúc hiện tại — FB Personal Messenger CRM

> Trạng thái **as-is**, đối chiếu trực tiếp từ mã nguồn ngày 06/09/2026.

## 1. Kiến trúc tổng thể

```mermaid
flowchart LR
    FB[Facebook / Messenger]
    LIC[Máy chủ License trung tâm]
    PAY[SePay / thanh toán]
    OLL[Ollama local]
    CAI[Cloud AI]

    subgraph APP[Ứng dụng Desktop Electron]
        EM[Electron Main<br/>src/electron.js]
        UI[React 19 + Vite<br/>Giao diện CRM]
        API[Express REST API<br/>port 5050]
        SIO[Socket.IO<br/>UI realtime]
        WSS[WebSocket Server<br/>Extension realtime]
        CORE[Business Services]
        PM[ProcessManager<br/>quản lý Chrome/account]
        DB[(SQLite local)]
        FILES[(AppData<br/>profile, log, media)]
    end

    subgraph CHROME[Chrome profile theo tài khoản]
        BG[Extension Service Worker<br/>background.js]
        CS[Content scripts<br/>content.js, injected.js,<br/>textFilter, callDirection]
        PAGE[Page scripts<br/>page_content.js,<br/>pageDirection.js]
    end

    EM -->|khởi động cùng tiến trình| API
    EM -->|mở localhost:5050| UI
    UI <-->|REST| API
    UI <-->|sự kiện realtime| SIO
    API --- SIO
    API --- WSS
    API --> CORE
    CORE --> DB
    CORE --> FILES
    CORE --> PM
    PM -->|mở/đóng profile| CHROME
    WSS <-->|ws://127.0.0.1:5050| BG
    BG <-->|Chrome runtime messages| CS
    BG <-->|Chrome runtime messages| PAGE
    CS <-->|DOM, GraphQL, WebSocket| FB
    PAGE <-->|DOM trang Business| FB
    CORE --> LIC
    LIC <--> PAY
    CORE --> OLL
    CORE --> CAI
```

## 2. Các khối chức năng đang có

```mermaid
flowchart TB
    T[Transport]
    T --> REST[Express REST API]
    T --> SOCKET[Socket.IO cho giao diện]
    T --> EXTWS[WebSocket cho extension]

    D[Domain / nghiệp vụ]
    D --> ACC[Tài khoản Facebook<br/>ProcessManager, AccountService]
    D --> CRM[Hội thoại, liên hệ, lead<br/>Contact, Inbox, History Sync]
    D --> MSG[Tin nhắn gửi/nhận<br/>Queue, Outbound, Rich Message]
    D --> CAMP[Campaign & Broadcast<br/>recipient, attachment, retry, recovery]
    D --> AUTO[Tự động hóa<br/>Auto Reply, Follow-up, Phone Capture]
    D --> AIX[AI Mediator<br/>Ollama / Cloud AI]
    D --> AUTH[Xác thực, phân quyền<br/>Enterprise Access, License]
    D --> CALL[Cuộc gọi Messenger<br/>nhận sự kiện và popup giao diện]

    I[Hạ tầng]
    I --> REPO[Repositories]
    I --> SQL[(better-sqlite3)]
    I --> MEDIA[Media Downloader<br/>Attachment & Avatar]
    I --> EXPORT[Excel / CSV Export]
    I --> LOG[Log Electron / Server / Extension]

    T --> D
    D --> I
```

## 3. Luồng tin nhắn realtime

```mermaid
sequenceDiagram
    participant FB as Facebook/Messenger
    participant CS as Content/Page Script
    participant BG as Extension background
    participant WS as Backend WebSocket
    participant SV as Services
    participant DB as SQLite
    participant UI as React CRM

    FB->>CS: DOM/GraphQL/WebSocket thay đổi
    CS->>BG: chrome.runtime.sendMessage
    BG->>WS: Sự kiện chuẩn hóa + accountId
    WS->>SV: kiểm tra, tương quan, chống trùng
    SV->>DB: lưu thread/message/status
    SV-->>UI: Socket.IO event
    UI-->>UI: cập nhật hội thoại realtime

    UI->>SV: yêu cầu gửi tin nhắn
    SV->>DB: tạo queue/attempt
    SV->>WS: lệnh gửi theo đúng account
    WS->>BG: chuyển lệnh cho extension
    BG->>CS: thao tác trong tab Messenger
    CS->>FB: gửi text/media/action
    FB-->>CS: kết quả/thay đổi trạng thái
    CS-->>SV: confirmation/error
    SV->>DB: cập nhật trạng thái
    SV-->>UI: kết quả realtime
```

## 4. Luồng chiến dịch gửi hàng loạt

```mermaid
flowchart LR
    U[Người dùng tạo campaign] --> API[Campaign API]
    API --> ELIG[Kiểm tra eligibility]
    ELIG --> REC[(Recipients)]
    API --> ATT[Chuẩn hóa attachment]
    ATT --> MAN[(Attachment manifests)]
    API --> RUN[Campaign Runner]
    RUN --> QUEUE[(Message queue)]
    QUEUE --> WORKER[Queue Worker]
    WORKER --> OUT[Outbound Message Service]
    OUT --> EXT[Extension theo account]
    EXT --> FB[Facebook/Messenger]
    FB --> CONF[DOM/GraphQL confirmation]
    CONF --> ATTEMPT[(Attempts & audit events)]
    ATTEMPT --> EVENT[Campaign Event Service]
    EVENT --> UI[Socket.IO cập nhật tiến độ]
    RUN --> RECOVERY[Retry / Recovery]
    RECOVERY --> QUEUE
```

## 5. Mô hình dữ liệu mức cao

```mermaid
erDiagram
    USERS ||--o{ AUTH_SESSIONS : has
    USERS ||--o{ ACCOUNT_USER_ASSIGNMENTS : assigned
    ACCOUNTS ||--o{ ACCOUNT_USER_ASSIGNMENTS : mapped
    ACCOUNTS ||--o{ INBOX_SOURCES : owns
    ACCOUNTS ||--o{ THREADS : syncs
    THREADS ||--o{ MESSAGES : contains
    THREADS ||--o{ CONVERSATION_REMINDERS : has
    THREADS ||--o| CONTACTS : represents
    CONTACTS ||--o{ CONTACT_PHONE_CAPTURES : captures
    LEAD_STATUSES ||--o{ CONTACTS : classifies
    ACCOUNTS ||--o{ AUTO_REPLIES : configures
    ACCOUNTS ||--o{ AI_CONFIGS : configures
    ACCOUNTS ||--o{ MESSAGE_QUEUE : sends
    MESSAGE_QUEUE ||--o{ OUTBOUND_ATTEMPTS : attempts
    MESSAGE_QUEUE ||--o{ OUTBOUND_ATTACHMENTS : includes
    CAMPAIGNS ||--o{ CAMPAIGN_RECIPIENTS : targets
    CAMPAIGNS ||--o{ CAMPAIGN_MESSAGES : contains
    CAMPAIGNS ||--o{ CAMPAIGN_ATTACHMENTS : includes
    CAMPAIGNS ||--o{ CAMPAIGN_ATTEMPTS : records
    CAMPAIGNS ||--o{ CAMPAIGN_AUDIT_EVENTS : audits
    CAMPAIGNS ||--o{ CAMPAIGN_PHONE_CAPTURE_ACTIONS : triggers
```

Các bảng chính hiện có: `users`, `auth_sessions`, `account_user_assignments`, `accounts`, `removed_accounts`, `inbox_sources`, `threads`, `conversation_reminders`, `messages`, `lead_statuses`, `phone_capture_automation_settings`, `contacts`, `contact_phone_captures`, `auto_replies`, `ai_configs`, `message_queue`, `outbound_attachments`, `outbound_attempts`, `campaigns`, `campaign_recipients`, `campaign_messages`, `campaign_attachment_manifests`, `campaign_attachments`, `campaign_attempts`, `campaign_audit_events`, `campaign_phone_capture_actions`.

## 6. Cấu trúc mã nguồn

```text
crm_fb/
├─ src/
│  ├─ electron.js                 # tiến trình chính Electron
│  ├─ preload.js                  # cầu nối an toàn Electron ↔ renderer
│  ├─ main.jsx, App.jsx           # ứng dụng React
│  ├─ components/                 # giao diện CRM
│  ├─ services/                   # client API/realtime phía UI
│  ├─ server/
│  │  ├─ server.js                # Express + Socket.IO + WebSocket
│  │  ├─ routes/                  # các REST endpoint
│  │  ├─ services/                # nghiệp vụ hệ thống
│  │  ├─ repositories/            # truy cập dữ liệu
│  │  ├─ database/                # schema + migration SQLite
│  │  └─ utils/                   # tiện ích backend
│  └─ extension/
│     ├─ manifest.json            # Chrome Extension MV3
│     ├─ background.js            # service worker + kết nối backend
│     ├─ content.js               # thao tác Messenger cá nhân
│     ├─ injected.js              # hook ngữ cảnh trang
│     ├─ page_content.js          # Messenger/Page/Business
│     └─ *Direction.js            # xác định chiều sự kiện/tin nhắn/cuộc gọi
├─ license_server/                # server license & thanh toán tách biệt
├─ tests/                         # unit/integration tests
├─ specs/                         # tài liệu đặc tả theo feature
├─ scripts/                       # build, migration, kiểm tra
├─ docs/                          # tài liệu dự án
└─ release/                       # bộ cài và bản win-unpacked
```

## 7. Ranh giới triển khai

- **Máy người dùng:** Electron, React UI, Express local, Socket.IO, WebSocket, SQLite, Chrome profiles và extension.
- **Hệ thống bên ngoài:** Facebook/Messenger, máy chủ license, SePay, Ollama hoặc Cloud AI.
- **Dữ liệu cục bộ:** tài khoản cấu hình, hội thoại, tin nhắn, chiến dịch, hàng đợi, trạng thái gửi, contact/lead, log và media.
- **Điểm kết nối quan trọng:** UI ↔ backend bằng REST/Socket.IO; extension ↔ backend bằng local WebSocket; extension ↔ Facebook bằng DOM/GraphQL/WebSocket trong trình duyệt.

