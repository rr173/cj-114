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
      item_type TEXT NOT NULL CHECK(item_type IN ('contract', 'spot', 'deviation', 'congestion_surplus')),
      contract_id TEXT,
      volume REAL NOT NULL,
      direction TEXT,
      unit_price REAL NOT NULL,
      amount REAL NOT NULL,
      exempt_amount REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (trading_day_id) REFERENCES trading_days(id),
      FOREIGN KEY (participant_id) REFERENCES market_participants(id),
      FOREIGN KEY (contract_id) REFERENCES mid_long_term_contracts(id)
    );

    CREATE TABLE IF NOT EXISTS supervision_anomalies (
      id TEXT PRIMARY KEY,
      trading_day_id TEXT NOT NULL,
      trade_date TEXT NOT NULL,
      hour INTEGER NOT NULL CHECK(hour BETWEEN 0 AND 23),
      participant_id TEXT,
      anomaly_type TEXT NOT NULL CHECK(anomaly_type IN ('price_inflation', 'volume_price_manipulation', 'collusion_suspected')),
      metric_values TEXT NOT NULL,
      basis TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (trading_day_id) REFERENCES trading_days(id),
      FOREIGN KEY (participant_id) REFERENCES market_participants(id)
    );

    CREATE TABLE IF NOT EXISTS supervision_hhi_records (
      id TEXT PRIMARY KEY,
      trading_day_id TEXT NOT NULL,
      trade_date TEXT NOT NULL,
      hour INTEGER NOT NULL CHECK(hour BETWEEN 0 AND 23),
      hhi_value REAL NOT NULL,
      concentration_level TEXT NOT NULL CHECK(concentration_level IN ('low', 'moderate', 'high')),
      share_details TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (trading_day_id) REFERENCES trading_days(id),
      UNIQUE(trading_day_id, hour)
    );

    CREATE TABLE IF NOT EXISTS supervision_alerts (
      id TEXT PRIMARY KEY,
      trading_day_id TEXT NOT NULL,
      trade_date TEXT NOT NULL,
      hour INTEGER,
      alert_type TEXT NOT NULL CHECK(alert_type IN ('price_spike', 'price_drop', 'daily_price_anomaly', 'market_dominance')),
      participant_id TEXT,
      metric_values TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (trading_day_id) REFERENCES trading_days(id),
      FOREIGN KEY (participant_id) REFERENCES market_participants(id)
    );

    CREATE TABLE IF NOT EXISTS ancillary_service_registrations (
      id TEXT PRIMARY KEY,
      participant_id TEXT NOT NULL,
      service_type TEXT NOT NULL CHECK(service_type IN ('frequency', 'reserve')),
      adjustable_capacity REAL,
      response_rate REAL,
      reserve_capacity REAL,
      startup_time REAL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (participant_id) REFERENCES market_participants(id),
      UNIQUE(participant_id, service_type)
    );

    CREATE TABLE IF NOT EXISTS ancillary_service_bids (
      id TEXT PRIMARY KEY,
      trading_day_id TEXT NOT NULL,
      participant_id TEXT NOT NULL,
      service_type TEXT NOT NULL CHECK(service_type IN ('frequency', 'reserve')),
      capacity_price REAL NOT NULL,
      mileage_price REAL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (trading_day_id) REFERENCES trading_days(id),
      FOREIGN KEY (participant_id) REFERENCES market_participants(id),
      UNIQUE(trading_day_id, participant_id, service_type)
    );

    CREATE TABLE IF NOT EXISTS ancillary_clearing_results (
      id TEXT PRIMARY KEY,
      trading_day_id TEXT NOT NULL,
      service_type TEXT NOT NULL CHECK(service_type IN ('frequency', 'reserve')),
      clearing_price REAL NOT NULL,
      mileage_clearing_price REAL,
      total_cleared_capacity REAL NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (trading_day_id) REFERENCES trading_days(id),
      UNIQUE(trading_day_id, service_type)
    );

    CREATE TABLE IF NOT EXISTS ancillary_clearing_allocations (
      id TEXT PRIMARY KEY,
      clearing_result_id TEXT NOT NULL,
      participant_id TEXT NOT NULL,
      hour INTEGER NOT NULL CHECK(hour BETWEEN 0 AND 23),
      cleared_capacity REAL NOT NULL,
      clearing_price REAL NOT NULL,
      mileage_clearing_price REAL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (clearing_result_id) REFERENCES ancillary_clearing_results(id),
      FOREIGN KEY (participant_id) REFERENCES market_participants(id),
      UNIQUE(clearing_result_id, participant_id, hour)
    );

    CREATE TABLE IF NOT EXISTS ancillary_mileage_submissions (
      id TEXT PRIMARY KEY,
      participant_id TEXT NOT NULL,
      month TEXT NOT NULL,
      actual_mileage REAL NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (participant_id) REFERENCES market_participants(id),
      UNIQUE(participant_id, month)
    );

    CREATE TABLE IF NOT EXISTS ancillary_service_settlements (
      id TEXT PRIMARY KEY,
      participant_id TEXT NOT NULL,
      month TEXT NOT NULL,
      service_type TEXT NOT NULL CHECK(service_type IN ('frequency', 'reserve')),
      winning_hours INTEGER NOT NULL,
      total_winning_capacity REAL NOT NULL,
      capacity_clearing_price REAL NOT NULL,
      capacity_fee REAL NOT NULL,
      mileage_clearing_price REAL,
      actual_mileage REAL,
      mileage_fee REAL,
      total_fee REAL NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (participant_id) REFERENCES market_participants(id),
      UNIQUE(participant_id, month, service_type)
    );

    CREATE TABLE IF NOT EXISTS price_zones (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS price_zone_participants (
      id TEXT PRIMARY KEY,
      zone_id TEXT NOT NULL,
      participant_id TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (zone_id) REFERENCES price_zones(id) ON DELETE CASCADE,
      FOREIGN KEY (participant_id) REFERENCES market_participants(id) ON DELETE CASCADE,
      UNIQUE(zone_id, participant_id)
    );

    CREATE TABLE IF NOT EXISTS tie_lines (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      from_zone_id TEXT NOT NULL,
      to_zone_id TEXT NOT NULL,
      max_transfer_capacity REAL NOT NULL,
      description TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (from_zone_id) REFERENCES price_zones(id),
      FOREIGN KEY (to_zone_id) REFERENCES price_zones(id)
    );

    CREATE TABLE IF NOT EXISTS zone_clearing_results (
      id TEXT PRIMARY KEY,
      clearing_result_id TEXT NOT NULL,
      zone_id TEXT NOT NULL,
      clearing_price REAL NOT NULL,
      clearing_volume REAL NOT NULL,
      net_export REAL NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (clearing_result_id) REFERENCES clearing_results(id) ON DELETE CASCADE,
      FOREIGN KEY (zone_id) REFERENCES price_zones(id),
      UNIQUE(clearing_result_id, zone_id)
    );

    CREATE TABLE IF NOT EXISTS tie_line_flows (
      id TEXT PRIMARY KEY,
      clearing_result_id TEXT NOT NULL,
      tie_line_id TEXT NOT NULL,
      flow_direction TEXT NOT NULL CHECK(flow_direction IN ('forward', 'reverse', 'zero')),
      actual_flow REAL NOT NULL DEFAULT 0,
      congestion_level REAL NOT NULL DEFAULT 0,
      is_congested INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (clearing_result_id) REFERENCES clearing_results(id) ON DELETE CASCADE,
      FOREIGN KEY (tie_line_id) REFERENCES tie_lines(id),
      UNIQUE(clearing_result_id, tie_line_id)
    );

    CREATE TABLE IF NOT EXISTS congestion_surplus (
      id TEXT PRIMARY KEY,
      trading_day_id TEXT NOT NULL,
      hour INTEGER NOT NULL CHECK(hour BETWEEN 0 AND 23),
      tie_line_id TEXT NOT NULL,
      total_surplus REAL NOT NULL DEFAULT 0,
      from_zone_share REAL NOT NULL DEFAULT 0,
      to_zone_share REAL NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (trading_day_id) REFERENCES trading_days(id),
      FOREIGN KEY (tie_line_id) REFERENCES tie_lines(id),
      UNIQUE(trading_day_id, hour, tie_line_id)
    );
  `);
}

initDatabase();

try { db.exec(`ALTER TABLE trading_days ADD COLUMN frequency_demand REAL`); } catch (e) {}
try { db.exec(`ALTER TABLE trading_days ADD COLUMN reserve_demand REAL`); } catch (e) {}
try { db.exec(`ALTER TABLE settlement_details ADD COLUMN exempt_amount REAL DEFAULT 0`); } catch (e) {}
try { db.exec(`ALTER TABLE clearing_results ADD COLUMN clearing_type TEXT DEFAULT 'unified' CHECK(clearing_type IN ('unified', 'zoned'))`); } catch (e) {}

module.exports = db;
