const { v4: uuidv4 } = require('uuid');
const db = require('../utils/db');

function createTradingDay(data) {
  const { trade_date, bid_deadline } = data;

  if (!trade_date || !bid_deadline) {
    throw new Error('交易日和报价截止时间为必填项');
  }

  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  if (!datePattern.test(trade_date)) {
    throw new Error('交易日格式应为 YYYY-MM-DD');
  }

  const existing = db.prepare('SELECT id FROM trading_days WHERE trade_date = ?').get(trade_date);
  if (existing) {
    throw new Error('该交易日已存在');
  }

  const id = uuidv4();
  db.prepare(`
    INSERT INTO trading_days (id, trade_date, bid_deadline, status)
    VALUES (?, ?, ?, 'bidding')
  `).run(id, trade_date, bid_deadline);

  return getTradingDayById(id);
}

function getTradingDayById(id) {
  return db.prepare('SELECT * FROM trading_days WHERE id = ?').get(id);
}

function getTradingDayByDate(trade_date) {
  return db.prepare('SELECT * FROM trading_days WHERE trade_date = ?').get(trade_date);
}

function listTradingDays() {
  return db.prepare('SELECT * FROM trading_days ORDER BY trade_date DESC').all();
}

function isBiddingOpen(tradingDayId) {
  const td = getTradingDayById(tradingDayId);
  if (!td) return false;
  if (td.status !== 'bidding') return false;
  const now = new Date();
  const deadline = new Date(td.bid_deadline);
  return now < deadline;
}

function getClearingPrices(tradingDayId) {
  const td = getTradingDayById(tradingDayId);
  if (!td) {
    throw new Error('交易日不存在');
  }
  if (td.status === 'bidding') {
    throw new Error('该交易日尚未出清');
  }
  const results = db.prepare(`
    SELECT hour, clearing_price, clearing_volume
    FROM clearing_results
    WHERE trading_day_id = ?
    ORDER BY hour
  `).all(tradingDayId);

  return {
    trade_date: td.trade_date,
    status: td.status,
    prices: results
  };
}

module.exports = {
  createTradingDay,
  getTradingDayById,
  getTradingDayByDate,
  listTradingDays,
  isBiddingOpen,
  getClearingPrices
};
