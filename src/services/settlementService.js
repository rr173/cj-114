const { v4: uuidv4 } = require('uuid');
const db = require('../utils/db');
const { getTradingDayById } = require('./tradingDayService');
const { listParticipants, getParticipantById } = require('./participantService');

const POSITIVE_DEVIATION_RATIO = 0.8;
const NEGATIVE_DEVIATION_RATIO = 1.2;

function submitActualVolumes(tradingDayId, participantId, volumes) {
  const td = getTradingDayById(tradingDayId);
  if (!td) {
    throw new Error('交易日不存在');
  }
  if (td.status === 'bidding') {
    throw new Error('该交易日尚未出清');
  }
  if (td.status === 'settled') {
    throw new Error('该交易日已完成结算，不可修改实际量');
  }

  const p = getParticipantById(participantId);
  if (!p) {
    throw new Error('市场主体不存在');
  }

  if (!Array.isArray(volumes) || volumes.length === 0) {
    throw new Error('实际量数据不能为空');
  }

  for (const v of volumes) {
    const { hour, actual_volume } = v;
    if (hour == null || hour < 0 || hour > 23) {
      throw new Error('时段必须在 0-23 之间');
    }
    if (actual_volume == null || actual_volume < 0) {
      throw new Error(`时段 ${hour} 实际量无效`);
    }
  }

  const tx = db.transaction(() => {
    const deleteStmt = db.prepare(`
      DELETE FROM actual_volumes
      WHERE trading_day_id = ? AND participant_id = ? AND hour = ?
    `);
    const insertStmt = db.prepare(`
      INSERT INTO actual_volumes (id, trading_day_id, participant_id, hour, actual_volume)
      VALUES (?, ?, ?, ?, ?)
    `);

    for (const v of volumes) {
      deleteStmt.run(tradingDayId, participantId, v.hour);
      insertStmt.run(uuidv4(), tradingDayId, participantId, v.hour, v.actual_volume);
    }
  });

  tx();

  return getActualVolumes(tradingDayId, participantId);
}

function getActualVolumes(tradingDayId, participantId) {
  return db.prepare(`
    SELECT hour, actual_volume
    FROM actual_volumes
    WHERE trading_day_id = ? AND participant_id = ?
    ORDER BY hour
  `).all(tradingDayId, participantId);
}

function executeSettlement(tradingDayId) {
  const td = getTradingDayById(tradingDayId);
  if (!td) {
    throw new Error('交易日不存在');
  }
  if (td.status !== 'cleared') {
    throw new Error('只有已出清的交易日可以执行结算');
  }

  const allocations = db.prepare(`
    SELECT cr.hour, cr.clearing_price,
           ca.participant_id, ca.final_dispatch,
           p.type
    FROM clearing_results cr
    JOIN clearing_allocations ca ON cr.id = ca.clearing_result_id
    JOIN market_participants p ON ca.participant_id = p.id
    WHERE cr.trading_day_id = ?
    ORDER BY cr.hour, p.type
  `).all(tradingDayId);

  const actualVolumes = db.prepare(`
    SELECT participant_id, hour, actual_volume
    FROM actual_volumes
    WHERE trading_day_id = ?
  `).all(tradingDayId);

  const actualMap = {};
  for (const av of actualVolumes) {
    if (!actualMap[av.participant_id]) actualMap[av.participant_id] = {};
    actualMap[av.participant_id][av.hour] = av.actual_volume;
  }

  const missing = [];
  const allParticipants = listParticipants();
  for (const p of allParticipants) {
    for (let h = 0; h < 24; h++) {
      const hasAlloc = allocations.find(a => a.participant_id === p.id && a.hour === h);
      if (hasAlloc && hasAlloc.final_dispatch > 0) {
        if (!actualMap[p.id] || actualMap[p.id][h] == null) {
          missing.push(`${p.code} 时段${h}`);
        }
      }
    }
  }

  if (missing.length > 0) {
    throw new Error(`以下主体时段缺少实际量数据: ${missing.join(', ')}`);
  }

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM settlement_details WHERE trading_day_id = ?').run(tradingDayId);

    const insertStmt = db.prepare(`
      INSERT INTO settlement_details
      (id, trading_day_id, participant_id, hour, bid_volume, actual_volume,
       deviation, deviation_direction, clearing_price, settlement_price, settlement_amount)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const alloc of allocations) {
      const bidVolume = alloc.final_dispatch || 0;
      const actualVolume = actualMap[alloc.participant_id]?.[alloc.hour] || 0;

      let deviation = actualVolume - bidVolume;
      if (alloc.type === 'consumer') {
        deviation = bidVolume - actualVolume;
      }

      let deviationDirection;
      let settlementPrice;
      const clearingPrice = alloc.clearing_price || 0;

      const EPSILON = 0.0001;
      if (Math.abs(deviation) < EPSILON) {
        deviationDirection = 'zero';
        settlementPrice = clearingPrice;
        deviation = 0;
      } else if (deviation > 0) {
        deviationDirection = 'positive';
        settlementPrice = clearingPrice * POSITIVE_DEVIATION_RATIO;
      } else {
        deviationDirection = 'negative';
        settlementPrice = clearingPrice * NEGATIVE_DEVIATION_RATIO;
      }

      const absDeviation = Math.abs(deviation);
      const settlementAmount = absDeviation * (settlementPrice - clearingPrice);

      insertStmt.run(
        uuidv4(),
        tradingDayId,
        alloc.participant_id,
        alloc.hour,
        bidVolume,
        actualVolume,
        deviation,
        deviationDirection,
        clearingPrice,
        settlementPrice,
        settlementAmount
      );
    }

    db.prepare('UPDATE trading_days SET status = ? WHERE id = ?').run('settled', tradingDayId);
  });

  tx();

  return getSettlementByTradingDay(tradingDayId);
}

function getSettlementByTradingDay(tradingDayId) {
  const td = getTradingDayById(tradingDayId);
  if (!td) throw new Error('交易日不存在');

  const rows = db.prepare(`
    SELECT s.*, p.code, p.name, p.type
    FROM settlement_details s
    JOIN market_participants p ON s.participant_id = p.id
    WHERE s.trading_day_id = ?
    ORDER BY s.hour, p.type, p.code
  `).all(tradingDayId);

  const byParticipant = {};
  const byHour = {};
  let totalAmount = 0;

  for (const row of rows) {
    if (!byParticipant[row.participant_id]) {
      byParticipant[row.participant_id] = {
        participant_id: row.participant_id,
        code: row.code,
        name: row.name,
        type: row.type,
        total_bid: 0,
        total_actual: 0,
        total_deviation: 0,
        total_settlement_amount: 0,
        hourly: []
      };
    }
    byParticipant[row.participant_id].total_bid += row.bid_volume;
    byParticipant[row.participant_id].total_actual += row.actual_volume;
    byParticipant[row.participant_id].total_deviation += row.deviation;
    byParticipant[row.participant_id].total_settlement_amount += row.settlement_amount;
    byParticipant[row.participant_id].hourly.push({
      hour: row.hour,
      bid_volume: row.bid_volume,
      actual_volume: row.actual_volume,
      deviation: row.deviation,
      deviation_direction: row.deviation_direction,
      clearing_price: row.clearing_price,
      settlement_price: row.settlement_price,
      settlement_amount: row.settlement_amount
    });

    totalAmount += row.settlement_amount;
  }

  return {
    trading_day_id: tradingDayId,
    trade_date: td.trade_date,
    status: td.status,
    total_settlement_amount: totalAmount,
    participants: Object.values(byParticipant)
  };
}

function getSettlementByParticipant(tradingDayId, participantId) {
  const td = getTradingDayById(tradingDayId);
  if (!td) throw new Error('交易日不存在');
  const p = getParticipantById(participantId);
  if (!p) throw new Error('市场主体不存在');

  const rows = db.prepare(`
    SELECT * FROM settlement_details
    WHERE trading_day_id = ? AND participant_id = ?
    ORDER BY hour
  `).all(tradingDayId, participantId);

  let totalBid = 0, totalActual = 0, totalDeviation = 0, totalAmount = 0;
  for (const row of rows) {
    totalBid += row.bid_volume;
    totalActual += row.actual_volume;
    totalDeviation += row.deviation;
    totalAmount += row.settlement_amount;
  }

  return {
    participant: p,
    trade_date: td.trade_date,
    status: td.status,
    summary: {
      total_bid: totalBid,
      total_actual: totalActual,
      total_deviation: totalDeviation,
      total_settlement_amount: totalAmount
    },
    details: rows
  };
}

function getFullParticipantReport(tradingDayId, participantId) {
  const td = getTradingDayById(tradingDayId);
  if (!td) throw new Error('交易日不存在');
  const p = getParticipantById(participantId);
  if (!p) throw new Error('市场主体不存在');

  const clearingRows = db.prepare(`
    SELECT cr.hour, cr.clearing_price,
           ca.initial_allocation, ca.adjusted_allocation, ca.final_dispatch, ca.adjustment_reason
    FROM clearing_results cr
    JOIN clearing_allocations ca ON cr.id = ca.clearing_result_id
    WHERE cr.trading_day_id = ? AND ca.participant_id = ?
    ORDER BY cr.hour
  `).all(tradingDayId, participantId);

  const actualRows = db.prepare(`
    SELECT hour, actual_volume
    FROM actual_volumes
    WHERE trading_day_id = ? AND participant_id = ?
    ORDER BY hour
  `).all(tradingDayId, participantId);

  const settlementRows = db.prepare(`
    SELECT hour, bid_volume, actual_volume, deviation, deviation_direction,
           clearing_price, settlement_price, settlement_amount
    FROM settlement_details
    WHERE trading_day_id = ? AND participant_id = ?
    ORDER BY hour
  `).all(tradingDayId, participantId);

  const hourlyMap = {};
  for (let h = 0; h < 24; h++) hourlyMap[h] = { hour: h };

  for (const r of clearingRows) {
    hourlyMap[r.hour] = { ...hourlyMap[r.hour], clearing_price: r.clearing_price,
      initial_allocation: r.initial_allocation, adjusted_allocation: r.adjusted_allocation,
      final_dispatch: r.final_dispatch, adjustment_reason: r.adjustment_reason };
  }
  for (const r of actualRows) {
    hourlyMap[r.hour] = { ...hourlyMap[r.hour], actual_volume: r.actual_volume };
  }
  for (const r of settlementRows) {
    hourlyMap[r.hour] = { ...hourlyMap[r.hour],
      bid_volume: r.bid_volume, deviation: r.deviation,
      deviation_direction: r.deviation_direction, settlement_price: r.settlement_price,
      settlement_amount: r.settlement_amount };
  }

  const hourly = [];
  let totalBid = 0, totalActual = 0, totalDeviation = 0, totalSettlement = 0, totalClearing = 0;
  for (let h = 0; h < 24; h++) {
    const item = hourlyMap[h];
    hourly.push(item);
    if (item.final_dispatch) totalBid += item.final_dispatch;
    if (item.actual_volume) totalActual += item.actual_volume;
    if (item.deviation) totalDeviation += item.deviation;
    if (item.settlement_amount) totalSettlement += item.settlement_amount;
    if (item.final_dispatch && item.clearing_price) totalClearing += item.final_dispatch * item.clearing_price;
  }

  return {
    participant: p,
    trade_date: td.trade_date,
    status: td.status,
    summary: {
      total_bid_volume: totalBid,
      total_actual_volume: totalActual,
      total_deviation: totalDeviation,
      total_clearing_amount: totalClearing,
      total_deviation_settlement: totalSettlement
    },
    hourly
  };
}

module.exports = {
  submitActualVolumes,
  getActualVolumes,
  executeSettlement,
  getSettlementByTradingDay,
  getSettlementByParticipant,
  getFullParticipantReport
};
