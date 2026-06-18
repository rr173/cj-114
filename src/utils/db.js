const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '../../data/market.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS market_participants (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('generator', 'consumer')),
      installed_capacity REAL,
      min_output REAL,
      ramp_rate REAL,
      contracted_capacity REAL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS trading_days (
      id TEXT PRIMARY KEY,
      trade_date TEXT UNIQUE NOT NULL,
      bid_deadline TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'bidding' CHECK(status IN ('bidding', 'cleared', 'settled')),
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS generator_bids (
      id TEXT PRIMARY KEY,
      trading_day_id TEXT NOT NULL,
      participant_id TEXT NOT NULL,
      hour INTEGER NOT NULL CHECK(hour BETWEEN 0 AND 23),
      segment_index INTEGER NOT NULL,
      price REAL NOT NULL,
      capacity REAL NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (trading_day_id) REFERENCES trading_days(id),
      FOREIGN KEY (participant_id) REFERENCES market_participants(id),
      UNIQUE(trading_day_id, participant_id, hour, segment_index)
    );

    CREATE TABLE IF NOT EXISTS consumer_bids (
      id TEXT PRIMARY KEY,
      trading_day_id TEXT NOT NULL,
      participant_id TEXT NOT NULL,
      hour INTEGER NOT NULL CHECK(hour BETWEEN 0 AND 23),
      demand REAL NOT NULL,
      max_price REAL NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (trading_day_id) REFERENCES trading_days(id),
      FOREIGN KEY (participant_id) REFERENCES market_participants(id),
      UNIQUE(trading_day_id, participant_id, hour)
    );

    CREATE TABLE IF NOT EXISTS clearing_results (
      id TEXT PRIMARY KEY,
      trading_day_id TEXT NOT NULL,
      hour INTEGER NOT NULL CHECK(hour BETWEEN 0 AND 23),
      clearing_price REAL NOT NULL,
      clearing_volume REAL NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (trading_day_id) REFERENCES trading_days(id),
      UNIQUE(trading_day_id, hour)
    );

    CREATE TABLE IF NOT EXISTS clearing_allocations (
      id TEXT PRIMARY KEY,
      clearing_result_id TEXT NOT NULL,
      participant_id TEXT NOT NULL,
      initial_allocation REAL NOT NULL,
      adjusted_allocation REAL NOT NULL,
      final_dispatch REAL NOT NULL,
      adjustment_reason TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (clearing_result_id) REFERENCES clearing_results(id),
      FOREIGN KEY (participant_id) REFERENCES market_participants(id),
      UNIQUE(clearing_result_id, participant_id)
    );

    CREATE TABLE IF NOT EXISTS actual_volumes (
      id TEXT PRIMARY KEY,
      trading_day_id TEXT NOT NULL,
      participant_id TEXT NOT NULL,
      hour INTEGER NOT NULL CHECK(hour BETWEEN 0 AND 23),
      actual_volume REAL NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (trading_day_id) REFERENCES trading_days(id),
      FOREIGN KEY (participant_id) REFERENCES market_participants(id),
      UNIQUE(trading_day_id, participant_id, hour)
    );

    CREATE TABLE IF NOT EXISTS mid_long_term_contracts (
      id TEXT PRIMARY KEY,
      contract_no TEXT UNIQUE NOT NULL,
      buyer_id TEXT NOT NULL,
      seller_id TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      termination_date TEXT,
      total_energy REAL NOT NULL,
      contract_price REAL NOT NULL,
      decomposition_method TEXT NOT NULL CHECK(decomposition_method IN ('average', 'curve')),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'terminated')),
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (buyer_id) REFERENCES market_participants(id),
      FOREIGN KEY (seller_id) REFERENCES market_participants(id)
    );

    CREATE TABLE IF NOT EXISTS contract_decomposition_curves (
      id TEXT PRIMARY KEY,
      contract_id TEXT NOT NULL,
      hour INTEGER NOT NULL CHECK(hour BETWEEN 0 AND 23),
      ratio REAL NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (contract_id) REFERENCES mid_long_term_contracts(id) ON DELETE CASCADE,
      UNIQUE(contract_id, hour)
    );

    CREATE TABLE IF NOT EXISTS contract_decomposition_results (
      id TEXT PRIMARY KEY,
      contract_id TEXT NOT NULL,
      trading_day_id TEXT,
      trade_date TEXT NOT NULL,
      hour INTEGER NOT NULL CHECK(hour BETWEEN 0 AND 23),
      decomposed_energy REAL NOT NULL,
      buyer_id TEXT NOT NULL,
      seller_id TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (contract_id) REFERENCES mid_long_term_contracts(id),
      FOREIGN KEY (trading_day_id) REFERENCES trading_days(id),
      FOREIGN KEY (buyer_id) REFERENCES market_participants(id),
      FOREIGN KEY (seller_id) REFERENCES market_participants(id),
      UNIQUE(contract_id, trade_date, hour)
    );

    CREATE TABLE IF NOT EXISTS settlement_details (
      id TEXT PRIMARY KEY,
      trading_day_id TEXT NOT NULL,
      participant_id TEXT NOT NULL,
      hour INTEGER NOT NULL CHECK(hour BETWEEN 0 AND 23),
      item_type TEXT NOT NULL CHECK(item_type IN ('contract', 'spot', 'deviation')),
      contract_id TEXT,
      volume REAL NOT NULL,
      direction TEXT,
      unit_price REAL NOT NULL,
      amount REAL NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (trading_day_id) REFERENCES trading_days(id),
      FOREIGN KEY (participant_id) REFERENCES market_participants(id),
      FOREIGN KEY (contract_id) REFERENCES mid_long_term_contracts(id)
    );
  `);
}

initDatabase();

module.exports = db;
