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

    CREATE TABLE IF NOT EXISTS intraday_orders (
      id TEXT PRIMARY KEY,
      trading_day_id TEXT NOT NULL,
      participant_id TEXT NOT NULL,
      hour INTEGER NOT NULL CHECK(hour BETWEEN 0 AND 23),
      order_type TEXT NOT NULL CHECK(order_type IN ('increase_gen', 'decrease_gen', 'increase_con', 'decrease_con')),
      side TEXT NOT NULL CHECK(side IN ('buy', 'sell')),
      quantity REAL NOT NULL,
      price REAL NOT NULL,
      remaining_quantity REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'partial', 'filled', 'cancelled')),
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (trading_day_id) REFERENCES trading_days(id),
      FOREIGN KEY (participant_id) REFERENCES market_participants(id)
    );

    CREATE TABLE IF NOT EXISTS intraday_trades (
      id TEXT PRIMARY KEY,
      trading_day_id TEXT NOT NULL,
      hour INTEGER NOT NULL CHECK(hour BETWEEN 0 AND 23),
      buy_order_id TEXT NOT NULL,
      sell_order_id TEXT NOT NULL,
      buy_participant_id TEXT NOT NULL,
      sell_participant_id TEXT NOT NULL,
      trade_quantity REAL NOT NULL,
      trade_price REAL NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (trading_day_id) REFERENCES trading_days(id),
      FOREIGN KEY (buy_order_id) REFERENCES intraday_orders(id),
      FOREIGN KEY (sell_order_id) REFERENCES intraday_orders(id),
      FOREIGN KEY (buy_participant_id) REFERENCES market_participants(id),
      FOREIGN KEY (sell_participant_id) REFERENCES market_participants(id)
    );

    CREATE TABLE IF NOT EXISTS green_certificates (
      id TEXT PRIMARY KEY,
      certificate_no TEXT UNIQUE NOT NULL,
      generator_id TEXT NOT NULL,
      energy_type TEXT NOT NULL CHECK(energy_type IN ('wind', 'solar', 'hydro', 'biomass', 'geothermal')),
      trading_day_id TEXT NOT NULL,
      trade_date TEXT NOT NULL,
      hour INTEGER NOT NULL CHECK(hour BETWEEN 0 AND 23),
      quantity REAL NOT NULL,
      owner_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available', 'transferred', 'traded', 'used')),
      source TEXT NOT NULL CHECK(source IN ('auto_issue', 'auto_allocation', 'market_trade')),
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (generator_id) REFERENCES market_participants(id),
      FOREIGN KEY (owner_id) REFERENCES market_participants(id),
      FOREIGN KEY (trading_day_id) REFERENCES trading_days(id)
    );

    CREATE TABLE IF NOT EXISTS gc_quota_settings (
      id TEXT PRIMARY KEY,
      year INTEGER NOT NULL UNIQUE,
      quota_ratio REAL NOT NULL CHECK(quota_ratio BETWEEN 0 AND 1),
      penalty_price REAL NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS gc_trading_sessions (
      id TEXT PRIMARY KEY,
      session_no TEXT UNIQUE NOT NULL,
      year INTEGER NOT NULL,
      month INTEGER NOT NULL CHECK(month BETWEEN 1 AND 12),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'bidding', 'completed', 'cancelled')),
      bid_start_time TEXT NOT NULL,
      bid_end_time TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(year, month)
    );

    CREATE TABLE IF NOT EXISTS gc_sell_orders (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      seller_id TEXT NOT NULL,
      min_price REAL NOT NULL CHECK(min_price >= 0),
      total_quantity INTEGER NOT NULL CHECK(total_quantity > 0),
      remaining_quantity INTEGER NOT NULL CHECK(remaining_quantity >= 0),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'partial', 'filled', 'cancelled')),
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES gc_trading_sessions(id),
      FOREIGN KEY (seller_id) REFERENCES market_participants(id)
    );

    CREATE TABLE IF NOT EXISTS gc_buy_orders (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      buyer_id TEXT NOT NULL,
      max_price REAL NOT NULL CHECK(max_price >= 0),
      demand_quantity INTEGER NOT NULL CHECK(demand_quantity > 0),
      remaining_quantity INTEGER NOT NULL CHECK(remaining_quantity >= 0),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'partial', 'filled', 'cancelled')),
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES gc_trading_sessions(id),
      FOREIGN KEY (buyer_id) REFERENCES market_participants(id)
    );

    CREATE TABLE IF NOT EXISTS gc_trades (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      sell_order_id TEXT NOT NULL,
      buy_order_id TEXT NOT NULL,
      seller_id TEXT NOT NULL,
      buyer_id TEXT NOT NULL,
      trade_quantity INTEGER NOT NULL CHECK(trade_quantity > 0),
      trade_price REAL NOT NULL CHECK(trade_price >= 0),
      total_amount REAL NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES gc_trading_sessions(id),
      FOREIGN KEY (sell_order_id) REFERENCES gc_sell_orders(id),
      FOREIGN KEY (buy_order_id) REFERENCES gc_buy_orders(id),
      FOREIGN KEY (seller_id) REFERENCES market_participants(id),
      FOREIGN KEY (buyer_id) REFERENCES market_participants(id)
    );

    CREATE TABLE IF NOT EXISTS gc_transfer_records (
      id TEXT PRIMARY KEY,
      certificate_id TEXT NOT NULL,
      from_participant_id TEXT NOT NULL,
      to_participant_id TEXT NOT NULL,
      transfer_type TEXT NOT NULL CHECK(transfer_type IN ('auto_allocation', 'market_trade', 'manual_transfer')),
      trade_id TEXT,
      reference_no TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (certificate_id) REFERENCES green_certificates(id),
      FOREIGN KEY (from_participant_id) REFERENCES market_participants(id),
      FOREIGN KEY (to_participant_id) REFERENCES market_participants(id),
      FOREIGN KEY (trade_id) REFERENCES gc_trades(id)
    );

    CREATE TABLE IF NOT EXISTS gc_annual_assessments (
      id TEXT PRIMARY KEY,
      year INTEGER NOT NULL,
      participant_id TEXT NOT NULL,
      total_purchase REAL NOT NULL DEFAULT 0,
      required_gc INTEGER NOT NULL DEFAULT 0,
      obtained_gc INTEGER NOT NULL DEFAULT 0,
      completion_rate REAL NOT NULL DEFAULT 0,
      is_compliant INTEGER NOT NULL DEFAULT 0,
      deficit_quantity INTEGER NOT NULL DEFAULT 0,
      penalty_amount REAL NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (participant_id) REFERENCES market_participants(id),
      UNIQUE(year, participant_id)
    );

    CREATE TABLE IF NOT EXISTS capacity_demands (
      id TEXT PRIMARY KEY,
      month TEXT NOT NULL UNIQUE,
      total_demand_mw REAL NOT NULL,
      reserve_margin REAL NOT NULL DEFAULT 0.15,
      peak_load_forecast REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'cancelled')),
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS capacity_obligations (
      id TEXT PRIMARY KEY,
      month TEXT NOT NULL,
      participant_id TEXT NOT NULL,
      obligation_mw REAL NOT NULL,
      purchase_share REAL NOT NULL,
      last_month_purchase REAL NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (participant_id) REFERENCES market_participants(id),
      UNIQUE(month, participant_id)
    );

    CREATE TABLE IF NOT EXISTS capacity_bidding_sessions (
      id TEXT PRIMARY KEY,
      month TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'bidding', 'closed', 'cleared')),
      bid_start_time TEXT,
      bid_end_time TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS capacity_bids (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      month TEXT NOT NULL,
      participant_id TEXT NOT NULL,
      offered_capacity_mw REAL NOT NULL,
      price_yuan_per_mw_month REAL NOT NULL,
      max_offer_capacity_mw REAL NOT NULL,
      contracted_capacity_mw REAL NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES capacity_bidding_sessions(id),
      FOREIGN KEY (participant_id) REFERENCES market_participants(id),
      UNIQUE(session_id, participant_id)
    );

    CREATE TABLE IF NOT EXISTS capacity_clearing_results (
      id TEXT PRIMARY KEY,
      month TEXT NOT NULL UNIQUE,
      clearing_price_yuan_per_mw REAL NOT NULL,
      total_cleared_capacity_mw REAL NOT NULL,
      total_demand_mw REAL NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS capacity_clearing_allocations (
      id TEXT PRIMARY KEY,
      clearing_result_id TEXT NOT NULL,
      participant_id TEXT NOT NULL,
      month TEXT NOT NULL,
      committed_capacity_mw REAL NOT NULL,
      clearing_price_yuan_per_mw REAL NOT NULL,
      monthly_compensation_yuan REAL NOT NULL,
      is_winner INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (clearing_result_id) REFERENCES capacity_clearing_results(id),
      FOREIGN KEY (participant_id) REFERENCES market_participants(id),
      UNIQUE(clearing_result_id, participant_id)
    );

    CREATE TABLE IF NOT EXISTS capacity_shortage_events (
      id TEXT PRIMARY KEY,
      month TEXT NOT NULL,
      participant_id TEXT NOT NULL,
      trading_day_id TEXT NOT NULL,
      trade_date TEXT NOT NULL,
      hour INTEGER NOT NULL CHECK(hour BETWEEN 0 AND 23),
      committed_capacity_mw REAL NOT NULL,
      actual_available_mw REAL NOT NULL,
      shortage_mw REAL NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (participant_id) REFERENCES market_participants(id),
      FOREIGN KEY (trading_day_id) REFERENCES trading_days(id),
      UNIQUE(participant_id, trading_day_id, hour)
    );

    CREATE TABLE IF NOT EXISTS capacity_availability_assessments (
      id TEXT PRIMARY KEY,
      month TEXT NOT NULL,
      participant_id TEXT NOT NULL,
      committed_capacity_mw REAL NOT NULL,
      total_required_periods INTEGER NOT NULL,
      available_periods INTEGER NOT NULL,
      availability_rate REAL NOT NULL,
      threshold_rate REAL NOT NULL DEFAULT 0.95,
      is_compliant INTEGER NOT NULL DEFAULT 1,
      original_compensation REAL NOT NULL,
      deduction_ratio REAL NOT NULL DEFAULT 0,
      deduction_amount REAL NOT NULL DEFAULT 0,
      final_compensation REAL NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (participant_id) REFERENCES market_participants(id),
      UNIQUE(month, participant_id)
    );

    CREATE TABLE IF NOT EXISTS capacity_settlements (
      id TEXT PRIMARY KEY,
      month TEXT NOT NULL,
      total_compensation REAL NOT NULL,
      total_deduction REAL NOT NULL,
      net_payable REAL NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(month)
    );

    CREATE TABLE IF NOT EXISTS capacity_settlement_items (
      id TEXT PRIMARY KEY,
      settlement_id TEXT NOT NULL,
      participant_id TEXT NOT NULL,
      month TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('generator', 'consumer')),
      obligation_mw REAL,
      committed_capacity_mw REAL,
      share_ratio REAL,
      original_amount REAL,
      deduction_amount REAL,
      net_amount REAL NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (settlement_id) REFERENCES capacity_settlements(id),
      FOREIGN KEY (participant_id) REFERENCES market_participants(id),
      UNIQUE(settlement_id, participant_id)
    );

    CREATE TABLE IF NOT EXISTS settlement_disputes (
      id TEXT PRIMARY KEY,
      trading_day_id TEXT NOT NULL,
      participant_id TEXT NOT NULL,
      dispute_type TEXT NOT NULL CHECK(dispute_type IN ('deviation_error', 'clearing_price_error', 'contract_decomposition_error')),
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'accepted', 'recalculating', 'reviewing', 'adopted', 'rejected', 'withdrawn')),
      reject_reason TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (trading_day_id) REFERENCES trading_days(id),
      FOREIGN KEY (participant_id) REFERENCES market_participants(id)
    );

    CREATE TABLE IF NOT EXISTS settlement_recalculations (
      id TEXT PRIMARY KEY,
      dispute_id TEXT NOT NULL,
      trading_day_id TEXT NOT NULL,
      participant_id TEXT NOT NULL,
      hour INTEGER NOT NULL CHECK(hour BETWEEN 0 AND 23),
      item_type TEXT NOT NULL CHECK(item_type IN ('contract', 'spot', 'deviation', 'congestion_surplus', 'intraday')),
      contract_id TEXT,
      volume REAL NOT NULL,
      direction TEXT,
      unit_price REAL NOT NULL,
      amount REAL NOT NULL,
      exempt_amount REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (dispute_id) REFERENCES settlement_disputes(id),
      FOREIGN KEY (trading_day_id) REFERENCES trading_days(id),
      FOREIGN KEY (participant_id) REFERENCES market_participants(id),
      FOREIGN KEY (contract_id) REFERENCES mid_long_term_contracts(id)
    );

    CREATE TABLE IF NOT EXISTS settlement_dispute_refunds (
      id TEXT PRIMARY KEY,
      dispute_id TEXT NOT NULL,
      participant_id TEXT NOT NULL,
      trading_day_id TEXT NOT NULL,
      hour INTEGER NOT NULL CHECK(hour BETWEEN 0 AND 23),
      original_amount REAL NOT NULL,
      recalculated_amount REAL NOT NULL,
      difference_amount REAL NOT NULL,
      refund_type TEXT NOT NULL CHECK(refund_type IN ('refund', 'recovery')),
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (dispute_id) REFERENCES settlement_disputes(id),
      FOREIGN KEY (trading_day_id) REFERENCES trading_days(id),
      FOREIGN KEY (participant_id) REFERENCES market_participants(id)
    );

    CREATE TABLE IF NOT EXISTS ftr_auctions (
      id TEXT PRIMARY KEY,
      auction_no TEXT UNIQUE NOT NULL,
      month TEXT NOT NULL,
      tie_line_id TEXT NOT NULL,
      direction_zone_from TEXT NOT NULL,
      direction_zone_to TEXT NOT NULL,
      total_capacity_mw REAL NOT NULL CHECK(total_capacity_mw > 0),
      max_single_participant_ratio REAL NOT NULL DEFAULT 0.3,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'bidding', 'closed', 'cleared', 'cancelled')),
      bid_start_time TEXT,
      bid_end_time TEXT,
      clearing_price REAL,
      total_cleared_capacity_mw REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (tie_line_id) REFERENCES tie_lines(id)
    );

    CREATE TABLE IF NOT EXISTS ftr_bids (
      id TEXT PRIMARY KEY,
      auction_id TEXT NOT NULL,
      participant_id TEXT NOT NULL,
      bid_capacity_mw REAL NOT NULL CHECK(bid_capacity_mw > 0),
      bid_price REAL NOT NULL CHECK(bid_price >= 0),
      status TEXT NOT NULL DEFAULT 'submitted' CHECK(status IN ('submitted', 'accepted', 'rejected', 'partial', 'cancelled')),
      cleared_capacity_mw REAL DEFAULT 0,
      clearing_price REAL,
      payment_amount REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (auction_id) REFERENCES ftr_auctions(id),
      FOREIGN KEY (participant_id) REFERENCES market_participants(id)
    );

    CREATE TABLE IF NOT EXISTS ftr_holdings (
      id TEXT PRIMARY KEY,
      auction_id TEXT NOT NULL,
      bid_id TEXT NOT NULL,
      participant_id TEXT NOT NULL,
      month TEXT NOT NULL,
      tie_line_id TEXT NOT NULL,
      direction_zone_from TEXT NOT NULL,
      direction_zone_to TEXT NOT NULL,
      holding_capacity_mw REAL NOT NULL CHECK(holding_capacity_mw > 0),
      clearing_price REAL NOT NULL,
      total_payment REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'settled', 'expired')),
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (auction_id) REFERENCES ftr_auctions(id),
      FOREIGN KEY (bid_id) REFERENCES ftr_bids(id),
      FOREIGN KEY (participant_id) REFERENCES market_participants(id),
      FOREIGN KEY (tie_line_id) REFERENCES tie_lines(id)
    );

    CREATE TABLE IF NOT EXISTS ftr_daily_settlements (
      id TEXT PRIMARY KEY,
      trading_day_id TEXT NOT NULL,
      trade_date TEXT NOT NULL,
      hour INTEGER NOT NULL CHECK(hour BETWEEN 0 AND 23),
      tie_line_id TEXT NOT NULL,
      congestion_price_diff REAL NOT NULL DEFAULT 0,
      actual_flow_mw REAL NOT NULL DEFAULT 0,
      total_congestion_surplus REAL NOT NULL DEFAULT 0,
      total_ftr_payment REAL NOT NULL DEFAULT 0,
      surplus_to_pool REAL NOT NULL DEFAULT 0,
      settlement_note TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (trading_day_id) REFERENCES trading_days(id),
      FOREIGN KEY (tie_line_id) REFERENCES tie_lines(id),
      UNIQUE(trading_day_id, hour, tie_line_id)
    );

    CREATE TABLE IF NOT EXISTS ftr_daily_settlement_items (
      id TEXT PRIMARY KEY,
      settlement_id TEXT NOT NULL,
      holding_id TEXT NOT NULL,
      participant_id TEXT NOT NULL,
      holding_capacity_mw REAL NOT NULL,
      congestion_price_diff REAL NOT NULL,
      original_income REAL NOT NULL,
      prorated_ratio REAL NOT NULL DEFAULT 1,
      final_income REAL NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (settlement_id) REFERENCES ftr_daily_settlements(id) ON DELETE CASCADE,
      FOREIGN KEY (holding_id) REFERENCES ftr_holdings(id),
      FOREIGN KEY (participant_id) REFERENCES market_participants(id)
    );

    CREATE TABLE IF NOT EXISTS congestion_surplus_pool (
      id TEXT PRIMARY KEY,
      month TEXT NOT NULL UNIQUE,
      opening_balance REAL NOT NULL DEFAULT 0,
      monthly_addition REAL NOT NULL DEFAULT 0,
      total_refunded REAL NOT NULL DEFAULT 0,
      closing_balance REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'accumulating' CHECK(status IN ('accumulating', 'refunded', 'carried_forward')),
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS congestion_surplus_refunds (
      id TEXT PRIMARY KEY,
      pool_id TEXT NOT NULL,
      month TEXT NOT NULL,
      participant_id TEXT NOT NULL,
      total_purchase_mwh REAL NOT NULL,
      total_market_purchase_mwh REAL NOT NULL,
      share_ratio REAL NOT NULL,
      refund_amount REAL NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (pool_id) REFERENCES congestion_surplus_pool(id),
      FOREIGN KEY (participant_id) REFERENCES market_participants(id),
      UNIQUE(pool_id, participant_id)
    );

    CREATE TABLE IF NOT EXISTS ftr_monthly_reports (
      id TEXT PRIMARY KEY,
      month TEXT NOT NULL UNIQUE,
      total_auctions INTEGER NOT NULL DEFAULT 0,
      total_ftr_holders INTEGER NOT NULL DEFAULT 0,
      total_holding_capacity_mw REAL NOT NULL DEFAULT 0,
      total_auction_payment REAL NOT NULL DEFAULT 0,
      total_settlement_income REAL NOT NULL DEFAULT 0,
      total_net_benefit REAL NOT NULL DEFAULT 0,
      total_congestion_surplus REAL NOT NULL DEFAULT 0,
      total_ftr_paid REAL NOT NULL DEFAULT 0,
      total_surplus_to_pool REAL NOT NULL DEFAULT 0,
      pool_refund_total REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'finalized')),
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ftr_monthly_report_items (
      id TEXT PRIMARY KEY,
      report_id TEXT NOT NULL,
      participant_id TEXT NOT NULL,
      holding_capacity_mw REAL NOT NULL DEFAULT 0,
      monthly_income REAL NOT NULL DEFAULT 0,
      auction_payment REAL NOT NULL DEFAULT 0,
      net_benefit REAL NOT NULL DEFAULT 0,
      pool_refund_amount REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (report_id) REFERENCES ftr_monthly_reports(id) ON DELETE CASCADE,
      FOREIGN KEY (participant_id) REFERENCES market_participants(id),
      UNIQUE(report_id, participant_id)
    );

    CREATE TABLE IF NOT EXISTS credit_scores (
      id TEXT PRIMARY KEY,
      participant_id TEXT NOT NULL,
      month TEXT NOT NULL,
      score REAL NOT NULL DEFAULT 70,
      level TEXT NOT NULL DEFAULT 'A',
      settlement_timeliness REAL NOT NULL DEFAULT 0,
      settlement_timeliness_score REAL NOT NULL DEFAULT 0,
      deviation_control REAL NOT NULL DEFAULT 0,
      deviation_control_score REAL NOT NULL DEFAULT 0,
      contract_performance REAL NOT NULL DEFAULT 0,
      contract_performance_score REAL NOT NULL DEFAULT 0,
      violation_count INTEGER NOT NULL DEFAULT 0,
      violation_score REAL NOT NULL DEFAULT 0,
      trading_restricted INTEGER NOT NULL DEFAULT 0,
      manually_adjusted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (participant_id) REFERENCES market_participants(id),
      UNIQUE(participant_id, month)
    );

    CREATE TABLE IF NOT EXISTS credit_margin_accounts (
      id TEXT PRIMARY KEY,
      participant_id TEXT NOT NULL UNIQUE,
      balance REAL NOT NULL DEFAULT 0,
      frozen_amount REAL NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (participant_id) REFERENCES market_participants(id)
    );

    CREATE TABLE IF NOT EXISTS credit_margin_transactions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      participant_id TEXT NOT NULL,
      transaction_type TEXT NOT NULL CHECK(transaction_type IN ('deposit', 'freeze', 'unfreeze', 'penalty', 'adjustment')),
      amount REAL NOT NULL,
      balance_after REAL NOT NULL,
      frozen_after REAL NOT NULL,
      reference_type TEXT,
      reference_id TEXT,
      description TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (account_id) REFERENCES credit_margin_accounts(id),
      FOREIGN KEY (participant_id) REFERENCES market_participants(id)
    );

    CREATE TABLE IF NOT EXISTS credit_margin_freezes (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      participant_id TEXT NOT NULL,
      trading_day_id TEXT NOT NULL,
      amount REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'frozen' CHECK(status IN ('frozen', 'unfrozen', 'penalized')),
      penalty_amount REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      unfrozen_at TEXT,
      FOREIGN KEY (account_id) REFERENCES credit_margin_accounts(id),
      FOREIGN KEY (participant_id) REFERENCES market_participants(id),
      FOREIGN KEY (trading_day_id) REFERENCES trading_days(id),
      UNIQUE(participant_id, trading_day_id)
    );

    CREATE TABLE IF NOT EXISTS credit_adjustment_records (
      id TEXT PRIMARY KEY,
      participant_id TEXT NOT NULL,
      month TEXT NOT NULL,
      original_score REAL NOT NULL,
      adjusted_score REAL NOT NULL,
      adjustment_reason TEXT NOT NULL,
      operator TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (participant_id) REFERENCES market_participants(id)
    );

    CREATE TABLE IF NOT EXISTS grid_buses (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      zone_id TEXT,
      bus_type TEXT NOT NULL CHECK(bus_type IN ('generator', 'load', 'tie')),
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (zone_id) REFERENCES price_zones(id)
    );

    CREATE TABLE IF NOT EXISTS grid_lines (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      from_bus_id TEXT NOT NULL,
      to_bus_id TEXT NOT NULL,
      reactance REAL NOT NULL,
      thermal_limit REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'in_service' CHECK(status IN ('in_service', 'out_of_service')),
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (from_bus_id) REFERENCES grid_buses(id),
      FOREIGN KEY (to_bus_id) REFERENCES grid_buses(id)
    );

    CREATE TABLE IF NOT EXISTS grid_bus_participants (
      id TEXT PRIMARY KEY,
      bus_id TEXT NOT NULL,
      participant_id TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (bus_id) REFERENCES grid_buses(id) ON DELETE CASCADE,
      FOREIGN KEY (participant_id) REFERENCES market_participants(id) ON DELETE CASCADE,
      UNIQUE(bus_id, participant_id)
    );

    CREATE TABLE IF NOT EXISTS grid_security_alerts (
      id TEXT PRIMARY KEY,
      trading_day_id TEXT NOT NULL,
      trade_date TEXT NOT NULL,
      hour INTEGER NOT NULL CHECK(hour BETWEEN 0 AND 23),
      security_level TEXT NOT NULL CHECK(security_level IN ('safe', 'warning', 'critical')),
      alert_details TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (trading_day_id) REFERENCES trading_days(id)
    );

    CREATE TABLE IF NOT EXISTS grid_security_violations (
      id TEXT PRIMARY KEY,
      alert_id TEXT NOT NULL,
      line_id TEXT NOT NULL,
      line_code TEXT NOT NULL,
      actual_flow REAL NOT NULL,
      thermal_limit REAL NOT NULL,
      violation_ratio REAL NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (alert_id) REFERENCES grid_security_alerts(id) ON DELETE CASCADE,
      FOREIGN KEY (line_id) REFERENCES grid_lines(id)
    );

    CREATE TABLE IF NOT EXISTS grid_redispatch_suggestions (
      id TEXT PRIMARY KEY,
      alert_id TEXT NOT NULL,
      trading_day_id TEXT NOT NULL,
      hour INTEGER NOT NULL CHECK(hour BETWEEN 0 AND 23),
      original_state TEXT NOT NULL,
      adjusted_state TEXT NOT NULL,
      adjustments TEXT NOT NULL,
      expected_relief TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (alert_id) REFERENCES grid_security_alerts(id) ON DELETE CASCADE,
      FOREIGN KEY (trading_day_id) REFERENCES trading_days(id)
    );

    CREATE TABLE IF NOT EXISTS grid_nminus1_results (
      id TEXT PRIMARY KEY,
      trading_day_id TEXT NOT NULL,
      trade_date TEXT NOT NULL,
      hour INTEGER NOT NULL CHECK(hour BETWEEN 0 AND 23),
      outage_line_id TEXT NOT NULL,
      outage_line_code TEXT NOT NULL,
      is_critical INTEGER NOT NULL DEFAULT 0,
      system_islanded INTEGER NOT NULL DEFAULT 0,
      violation_details TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (trading_day_id) REFERENCES trading_days(id),
      FOREIGN KEY (outage_line_id) REFERENCES grid_lines(id)
    );

    CREATE TABLE IF NOT EXISTS vpp_aggregators (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      participant_id TEXT NOT NULL,
      contact_person TEXT,
      contact_phone TEXT,
      service_fee_ratio REAL NOT NULL DEFAULT 0.1,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (participant_id) REFERENCES market_participants(id)
    );

    CREATE TABLE IF NOT EXISTS vpp_resources (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      aggregator_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('storage', 'interruptible_load', 'solar_pv', 'charging_pile')),
      rated_power_kw REAL NOT NULL,
      is_reliable INTEGER NOT NULL DEFAULT 1,
      owner_name TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (aggregator_id) REFERENCES vpp_aggregators(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS vpp_resource_states (
      id TEXT PRIMARY KEY,
      resource_id TEXT NOT NULL,
      trading_day_id TEXT,
      hour INTEGER CHECK(hour BETWEEN 0 AND 23),
      availability_factor REAL CHECK(availability_factor BETWEEN 0 AND 1),
      soc REAL CHECK(soc BETWEEN 0 AND 1),
      max_charge_power_kw REAL,
      max_discharge_power_kw REAL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (resource_id) REFERENCES vpp_resources(id) ON DELETE CASCADE,
      FOREIGN KEY (trading_day_id) REFERENCES trading_days(id),
      UNIQUE(resource_id, trading_day_id, hour)
    );

    CREATE TABLE IF NOT EXISTS vpp_bids (
      id TEXT PRIMARY KEY,
      aggregator_id TEXT NOT NULL,
      trading_day_id TEXT NOT NULL,
      hour INTEGER NOT NULL CHECK(hour BETWEEN 0 AND 23),
      adjustable_capacity_mw REAL NOT NULL,
      price_yuan_per_mwh REAL NOT NULL,
      cleared_capacity_mw REAL NOT NULL DEFAULT 0,
      clearing_price REAL NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (aggregator_id) REFERENCES vpp_aggregators(id),
      FOREIGN KEY (trading_day_id) REFERENCES trading_days(id),
      UNIQUE(aggregator_id, trading_day_id, hour)
    );

    CREATE TABLE IF NOT EXISTS vpp_output_distributions (
      id TEXT PRIMARY KEY,
      aggregator_id TEXT NOT NULL,
      trading_day_id TEXT NOT NULL,
      hour INTEGER NOT NULL CHECK(hour BETWEEN 0 AND 23),
      resource_id TEXT NOT NULL,
      bid_id TEXT,
      allocated_output_kw REAL NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (aggregator_id) REFERENCES vpp_aggregators(id),
      FOREIGN KEY (trading_day_id) REFERENCES trading_days(id),
      FOREIGN KEY (resource_id) REFERENCES vpp_resources(id),
      FOREIGN KEY (bid_id) REFERENCES vpp_bids(id)
    );

    CREATE TABLE IF NOT EXISTS vpp_actual_outputs (
      id TEXT PRIMARY KEY,
      resource_id TEXT NOT NULL,
      trading_day_id TEXT NOT NULL,
      hour INTEGER NOT NULL CHECK(hour BETWEEN 0 AND 23),
      actual_output_kw REAL NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (resource_id) REFERENCES vpp_resources(id),
      FOREIGN KEY (trading_day_id) REFERENCES trading_days(id),
      UNIQUE(resource_id, trading_day_id, hour)
    );

    CREATE TABLE IF NOT EXISTS vpp_performance_records (
      id TEXT PRIMARY KEY,
      resource_id TEXT NOT NULL,
      trading_day_id TEXT NOT NULL,
      hour INTEGER NOT NULL CHECK(hour BETWEEN 0 AND 23),
      allocated_output_kw REAL NOT NULL,
      actual_output_kw REAL NOT NULL,
      deviation_kw REAL NOT NULL,
      deviation_rate REAL NOT NULL,
      is_compliant INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (resource_id) REFERENCES vpp_resources(id),
      FOREIGN KEY (trading_day_id) REFERENCES trading_days(id),
      UNIQUE(resource_id, trading_day_id, hour)
    );

    CREATE TABLE IF NOT EXISTS vpp_performance_summary (
      id TEXT PRIMARY KEY,
      resource_id TEXT NOT NULL,
      month TEXT NOT NULL,
      total_periods INTEGER NOT NULL DEFAULT 0,
      compliant_periods INTEGER NOT NULL DEFAULT 0,
      non_compliant_periods INTEGER NOT NULL DEFAULT 0,
      compliance_rate REAL NOT NULL DEFAULT 0,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      is_marked_unreliable INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (resource_id) REFERENCES vpp_resources(id),
      UNIQUE(resource_id, month)
    );

    CREATE TABLE IF NOT EXISTS vpp_settlements (
      id TEXT PRIMARY KEY,
      aggregator_id TEXT NOT NULL,
      trading_day_id TEXT NOT NULL,
      total_cleared_energy_mwh REAL NOT NULL DEFAULT 0,
      total_actual_energy_mwh REAL NOT NULL DEFAULT 0,
      deviation_energy_mwh REAL NOT NULL DEFAULT 0,
      deviation_rate REAL NOT NULL DEFAULT 0,
      spot_revenue_yuan REAL NOT NULL DEFAULT 0,
      deviation_penalty_yuan REAL NOT NULL DEFAULT 0,
      total_revenue_yuan REAL NOT NULL DEFAULT 0,
      service_fee_yuan REAL NOT NULL DEFAULT 0,
      distributable_revenue_yuan REAL NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (aggregator_id) REFERENCES vpp_aggregators(id),
      FOREIGN KEY (trading_day_id) REFERENCES trading_days(id),
      UNIQUE(aggregator_id, trading_day_id)
    );

    CREATE TABLE IF NOT EXISTS vpp_revenue_allocations (
      id TEXT PRIMARY KEY,
      settlement_id TEXT NOT NULL,
      aggregator_id TEXT NOT NULL,
      trading_day_id TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      actual_energy_mwh REAL NOT NULL DEFAULT 0,
      contribution_ratio REAL NOT NULL DEFAULT 0,
      allocated_revenue_yuan REAL NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (settlement_id) REFERENCES vpp_settlements(id) ON DELETE CASCADE,
      FOREIGN KEY (aggregator_id) REFERENCES vpp_aggregators(id),
      FOREIGN KEY (trading_day_id) REFERENCES trading_days(id),
      FOREIGN KEY (resource_id) REFERENCES vpp_resources(id)
    );
  `);
}

initDatabase();

try { db.exec(`ALTER TABLE trading_days ADD COLUMN frequency_demand REAL`); } catch (e) {}
try { db.exec(`ALTER TABLE trading_days ADD COLUMN reserve_demand REAL`); } catch (e) {}
try { db.exec(`ALTER TABLE settlement_details ADD COLUMN exempt_amount REAL DEFAULT 0`); } catch (e) {}
try { db.exec(`ALTER TABLE clearing_results ADD COLUMN clearing_type TEXT DEFAULT 'unified' CHECK(clearing_type IN ('unified', 'zoned'))`); } catch (e) {}
try { db.exec(`ALTER TABLE market_participants ADD COLUMN energy_type TEXT`); } catch (e) {}
try { db.exec(`ALTER TABLE credit_scores ADD COLUMN manually_adjusted INTEGER NOT NULL DEFAULT 0`); } catch (e) {}

try {
  const initCreditData = db.transaction(() => {
    const participants = db.prepare(`SELECT id FROM market_participants`).all();
    const currentMonth = new Date().toISOString().slice(0, 7);
    
    const insertScore = db.prepare(`
      INSERT OR IGNORE INTO credit_scores 
      (id, participant_id, month, score, level, settlement_timeliness, settlement_timeliness_score,
       deviation_control, deviation_control_score, contract_performance, contract_performance_score,
       violation_count, violation_score, trading_restricted, manually_adjusted)
      VALUES (?, ?, ?, 70, 'A', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
    `);
    
    const insertAccount = db.prepare(`
      INSERT OR IGNORE INTO credit_margin_accounts 
      (id, participant_id, balance, frozen_amount)
      VALUES (?, ?, 0, 0)
    `);
    
    const { v4: uuidv4 } = require('uuid');
    for (const p of participants) {
      insertScore.run(uuidv4(), p.id, currentMonth);
      insertAccount.run(uuidv4(), p.id);
    }
  });
  initCreditData();
  console.log('[DB Migration] 信用数据初始化完成');
} catch (e) {
  console.log('[DB Migration] 信用数据初始化跳过:', e.message);
}

try {
  const migrateGcSource = db.transaction(() => {
    const existing = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='green_certificates'`).get();
    if (!existing) return;

    const check = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='green_certificates'`).get();
    if (check.sql.includes("'auto_allocation'")) return;

    db.exec(`
      CREATE TABLE green_certificates_new (
        id TEXT PRIMARY KEY,
        certificate_no TEXT UNIQUE NOT NULL,
        generator_id TEXT NOT NULL,
        energy_type TEXT NOT NULL CHECK(energy_type IN ('wind', 'solar', 'hydro', 'biomass', 'geothermal')),
        trading_day_id TEXT NOT NULL,
        trade_date TEXT NOT NULL,
        hour INTEGER NOT NULL CHECK(hour BETWEEN 0 AND 23),
        quantity REAL NOT NULL,
        owner_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available', 'transferred', 'traded', 'used')),
        source TEXT NOT NULL CHECK(source IN ('auto_issue', 'auto_allocation', 'market_trade')),
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (generator_id) REFERENCES market_participants(id),
        FOREIGN KEY (owner_id) REFERENCES market_participants(id),
        FOREIGN KEY (trading_day_id) REFERENCES trading_days(id)
      )
    `);
    db.exec('INSERT INTO green_certificates_new SELECT * FROM green_certificates');
    db.exec('DROP TABLE green_certificates');
    db.exec('ALTER TABLE green_certificates_new RENAME TO green_certificates');
    console.log('[DB Migration] green_certificates 表 source 字段 CHECK 约束已更新');
  });
  migrateGcSource();
} catch (e) {
  console.log('[DB Migration] green_certificates 表迁移跳过或失败:', e.message);
}

try {
  const migrateSettlement = db.transaction(() => {
    db.exec(`
      CREATE TABLE settlement_details_new (
        id TEXT PRIMARY KEY,
        trading_day_id TEXT NOT NULL,
        participant_id TEXT NOT NULL,
        hour INTEGER NOT NULL CHECK(hour BETWEEN 0 AND 23),
        item_type TEXT NOT NULL CHECK(item_type IN ('contract', 'spot', 'deviation', 'congestion_surplus', 'intraday')),
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
      )
    `);
    db.exec('INSERT INTO settlement_details_new SELECT * FROM settlement_details');
    db.exec('DROP TABLE settlement_details');
    db.exec('ALTER TABLE settlement_details_new RENAME TO settlement_details');
  });
  migrateSettlement();
} catch (e) {}

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS monthly_market_reports (
      id TEXT PRIMARY KEY,
      month TEXT UNIQUE NOT NULL,
      generated_at TEXT NOT NULL DEFAULT (datetime('now')),
      status TEXT NOT NULL DEFAULT 'final' CHECK(status IN ('draft', 'final')),
      spot_market_data TEXT,
      contract_data TEXT,
      ancillary_service_data TEXT,
      intraday_data TEXT,
      green_certificate_data TEXT,
      credit_margin_data TEXT,
      summary_data TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
  console.log('[DB Migration] 月度报告表初始化完成');
} catch (e) {
  console.log('[DB Migration] 月度报告表初始化跳过:', e.message);
}

module.exports = db;
