const mysql = require('mysql2/promise');
const { AsyncLocalStorage } = require('async_hooks');
const transactionStorage = new AsyncLocalStorage();

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 5),
  queueLimit: 0,
  charset: 'utf8mb4'
});

async function get(sql, params = [], connection = pool) {
  connection = transactionStorage.getStore() || connection;
  const [rows] = await connection.execute(sql, params);
  return rows[0];
}

async function all(sql, params = [], connection = pool) {
  connection = transactionStorage.getStore() || connection;
  const [rows] = await connection.execute(sql, params);
  return rows;
}

async function run(sql, params = [], connection = pool) {
  connection = transactionStorage.getStore() || connection;
  const [result] = await connection.execute(sql, params);
  return { changes: result.affectedRows, lastInsertRowid: result.insertId, ...result };
}

async function transaction(callback) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const tx = {
      get: (sql, params = []) => get(sql, params, connection),
      all: (sql, params = []) => all(sql, params, connection),
      run: (sql, params = []) => run(sql, params, connection)
    };
    const result = await transactionStorage.run(connection, () => callback(tx));
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

// Adapter keeps the old query shape while services move to async MySQL calls.
function prepare(sql) {
  return {
    get: (...params) => get(sql, params),
    all: (...params) => all(sql, params),
    run: (...params) => run(sql, params)
  };
}

function transactionCompat(callback) {
  return async () => transaction(async () => callback());
}

async function initialize() {
  if (!process.env.DB_USER || !process.env.DB_NAME) {
    throw new Error('Thiếu cấu hình MySQL: DB_USER và DB_NAME');
  }
  const statements = [
    `CREATE TABLE IF NOT EXISTS orders (
      id VARCHAR(64) PRIMARY KEY, order_code VARCHAR(32) NOT NULL UNIQUE,
      months INT NOT NULL DEFAULT 1, machines INT NOT NULL DEFAULT 1,
      unit_price INT NOT NULL DEFAULT 99000, total_amount INT NOT NULL,
      status ENUM('PENDING','PAID','CANCELLED') NOT NULL DEFAULT 'PENDING',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, paid_at DATETIME NULL,
      order_type VARCHAR(20) NOT NULL DEFAULT 'NEW', target_license_id BIGINT NULL,
      INDEX idx_orders_code (order_code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS pricing_settings (
      id TINYINT PRIMARY KEY, unit_price INT NOT NULL DEFAULT 99000,
      extra_slot_price INT NOT NULL DEFAULT 99000, discount_1 INT NOT NULL DEFAULT 0,
      discount_3 INT NOT NULL DEFAULT 5, discount_6 INT NOT NULL DEFAULT 10,
      discount_12 INT NOT NULL DEFAULT 20,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `INSERT IGNORE INTO pricing_settings
      (id,unit_price,extra_slot_price,discount_1,discount_3,discount_6,discount_12)
      VALUES (1,99000,99000,0,5,10,20)`,
    `CREATE TABLE IF NOT EXISTS licenses (
      id BIGINT AUTO_INCREMENT PRIMARY KEY, order_id VARCHAR(64) NULL,
      key_value VARCHAR(191) NOT NULL UNIQUE, machines INT NOT NULL DEFAULT 1,
      months INT NOT NULL DEFAULT 1, expires_at DATETIME NOT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1, company_name VARCHAR(255) NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_licenses_key (key_value),
      CONSTRAINT fk_licenses_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS license_devices (
      id BIGINT AUTO_INCREMENT PRIMARY KEY, license_id BIGINT NOT NULL,
      machine_id VARCHAR(191) NOT NULL, device_name VARCHAR(255) NULL,
      activated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_license_machine (license_id,machine_id),
      INDEX idx_devices_machine (machine_id),
      CONSTRAINT fk_devices_license FOREIGN KEY (license_id) REFERENCES licenses(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS client_users (
      id BIGINT AUTO_INCREMENT PRIMARY KEY, username VARCHAR(254) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      status ENUM('ACTIVE','BLOCKED') NOT NULL DEFAULT 'ACTIVE',
      last_login_at DATETIME NULL, last_machine_id VARCHAR(255) NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      license_id BIGINT NULL, company_admin_id BIGINT NULL,
      company_role ENUM('ADMIN','EMPLOYEE') NOT NULL DEFAULT 'ADMIN',
      google_id VARCHAR(191) NULL UNIQUE, email VARCHAR(254) NULL UNIQUE,
      avatar_url TEXT NULL, INDEX idx_client_users_status (status),
      CONSTRAINT fk_users_license FOREIGN KEY (license_id) REFERENCES licenses(id) ON DELETE SET NULL,
      CONSTRAINT fk_users_admin FOREIGN KEY (company_admin_id) REFERENCES client_users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  ];
  for (const sql of statements) {
    try { await pool.query(sql); }
    catch (error) {
      if (error.code !== 'ER_DUP_KEYNAME' && error.code !== 'ER_FK_DUP_NAME') throw error;
    }
  }
  const [foreignKeys] = await pool.query(
    `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'orders'
       AND CONSTRAINT_NAME = 'fk_orders_target_license' LIMIT 1`
  );
  if (!foreignKeys.length) {
    await pool.query(`ALTER TABLE orders ADD CONSTRAINT fk_orders_target_license
      FOREIGN KEY (target_license_id) REFERENCES licenses(id) ON DELETE SET NULL`);
  }
  await pool.query('SELECT 1');
  console.log('[LicenseDB] MySQL Database ready:', process.env.DB_HOST || 'localhost', process.env.DB_NAME);
}

module.exports = { pool, get, all, run, prepare, transaction: transactionCompat, withTransaction: transaction, ready: initialize() };
