-- BẢNG ĐƠN HÀNG THANH TOÁN
CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    order_code TEXT UNIQUE NOT NULL,
    months INTEGER NOT NULL DEFAULT 1,
    machines INTEGER NOT NULL DEFAULT 1,
    unit_price INTEGER NOT NULL DEFAULT 99000,
    total_amount INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING', -- PENDING | PAID | CANCELLED
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    paid_at DATETIME,
    order_type TEXT NOT NULL DEFAULT 'NEW',
    target_license_id INTEGER REFERENCES licenses(id) ON DELETE SET NULL
);

-- CẤU HÌNH BẢNG GIÁ ĐỘNG (một bản ghi duy nhất)
CREATE TABLE IF NOT EXISTS pricing_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    unit_price INTEGER NOT NULL DEFAULT 99000,
    extra_slot_price INTEGER NOT NULL DEFAULT 99000,
    discount_1 INTEGER NOT NULL DEFAULT 0,
    discount_3 INTEGER NOT NULL DEFAULT 5,
    discount_6 INTEGER NOT NULL DEFAULT 10,
    discount_12 INTEGER NOT NULL DEFAULT 20,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO pricing_settings (id, unit_price, discount_1, discount_3, discount_6, discount_12)
VALUES (1, 99000, 0, 5, 10, 20);

-- BẢNG MÃ LICENSE KEYS
CREATE TABLE IF NOT EXISTS licenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT REFERENCES orders(id),
    key_value TEXT UNIQUE NOT NULL,
    machines INTEGER NOT NULL DEFAULT 1,
    months INTEGER NOT NULL DEFAULT 1,
    expires_at DATETIME NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    company_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- BẢNG THIẾT BỊ / MÁY TÍNH ĐÃ KÍCH HOẠT KEY
CREATE TABLE IF NOT EXISTS license_devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    license_id INTEGER REFERENCES licenses(id) ON DELETE CASCADE,
    machine_id TEXT NOT NULL,
    device_name TEXT,
    activated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(license_id, machine_id)
);

CREATE INDEX IF NOT EXISTS idx_orders_code ON orders(order_code);
CREATE INDEX IF NOT EXISTS idx_licenses_key ON licenses(key_value);
CREATE INDEX IF NOT EXISTS idx_devices_machine ON license_devices(machine_id);

-- Tài khoản đăng nhập của các CRM client, quản lý tập trung tại Admin.
CREATE TABLE IF NOT EXISTS client_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'BLOCKED')),
    last_login_at DATETIME,
    last_machine_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    license_id INTEGER REFERENCES licenses(id) ON DELETE SET NULL
    ,company_admin_id INTEGER REFERENCES client_users(id) ON DELETE CASCADE
    ,company_role TEXT NOT NULL DEFAULT 'ADMIN' CHECK(company_role IN ('ADMIN','EMPLOYEE'))
);
CREATE INDEX IF NOT EXISTS idx_client_users_status ON client_users(status);
