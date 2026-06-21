const { v4: uuidv4 } = require('uuid');
const db = require('../utils/db');
const { getParticipantById, listParticipants } = require('./participantService');
const { getTradingDayById, listTradingDays } = require('./tradingDayService');

const MONTH_PATTERN = /^\d{4}-\d{2}$/;
const AVAILABILITY_THRESHOLD = 0.95;
const RESERVE_MARGIN = 0.15;

function isValidMonth(month) {
  return MONTH_PATTERN.test(month);
}

function getPreviousMonth(month) {
  const [year, m] = month.split('-').map(Number);
  const date = new Date(year, m - 2, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function setMonthlyDemand(month, peakLoadForecast, reserveMargin = RESERVE_MARGIN) {
  if (!isValidMonth(month)) throw new Error('月份格式应为 YYYY-MM');
  if (peakLoadForecast == null || peakLoadForecast <= 0) throw new Error('预计月度最大负荷必须大于0');
  if (reserveMargin == null || reserveMargin < 0 || reserveMargin > 1) throw new Error('备用裕度应在0到1之间');

  const totalDemandMw = peakLoadForecast * (1 + reserveMargin);

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO capacity_demands (id, month, total_demand_mw, reserve_margin, peak_load_forecast, status)
      VALUES (?, ?, ?, ?, ?, 'active')
      ON CONFLICT(month) DO UPDATE SET
        total_demand_mw = excluded.total_demand_mw,
        reserve_margin = excluded.reserve_margin,
        peak_load_forecast = excluded.peak_load_forecast,
        status = 'active'
    `).run(uuidv4(), month, totalDemandMw, reserveMargin, peakLoadForecast);
  });

  tx();
  return getMonthlyDemand(month);
}

function getMonthlyDemand(month) {
  if (!isValidMonth(month)) throw new Error('月份格式应为 YYYY-MM');
  const demand = db.prepare('SELECT * FROM capacity_demands WHERE month = ?').get(month);
  if (!demand) return null;
  return demand;
}

function calculateParticipantLastMonthPurchase(participantId, month) {
  const prevMonth = getPreviousMonth(month);
  const rows = db.prepare(`
    SELECT SUM(actual_volume) as total_purchase
    FROM actual_volumes av
    JOIN trading_days td ON av.trading_day_id = td.id
    WHERE av.participant_id = ? AND td.trade_date LIKE ?
  `).all(participantId, prevMonth + '%');

  let total = 0;
  for (const r of rows) {
    if (r.total_purchase) total += r.total_purchase;
  }
  return total;
}

function allocateCapacityObligations(month) {
  const demand = getMonthlyDemand(month);
  if (!demand) throw new Error('请先设定本月总容量需求');

  const consumers = listParticipants('consumer');
  if (consumers.length === 0) throw new Error('没有售电公司主体');

  const consumerPurchases = [];
  let totalPurchase = 0;

  for (const c of consumers) {
    const purchase = calculateParticipantLastMonthPurchase(c.id, month);
    consumerPurchases.push({
      participant_id: c.id,
      code: c.code,
      name: c.name,
      last_month_purchase: purchase
    });
    totalPurchase += purchase;
  }

  if (totalPurchase <= 0) {
    const equalShare = demand.total_demand_mw / consumers.length;
    for (const cp of consumerPurchases) {
      cp.purchase_share = 1 / consumers.length;
      cp.obligation_mw = equalShare;
    }
  } else {
    for (const cp of consumerPurchases) {
      cp.purchase_share = cp.last_month_purchase / totalPurchase;
      cp.obligation_mw = demand.total_demand_mw * cp.purchase_share;
    }
  }

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM capacity_obligations WHERE month = ?').run(month);

    const insertStmt = db.prepare(`
      INSERT INTO capacity_obligations
      (id, month, participant_id, obligation_mw, purchase_share, last_month_purchase)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const cp of consumerPurchases) {
      insertStmt.run(
        uuidv4(), month, cp.participant_id,
        cp.obligation_mw, cp.purchase_share, cp.last_month_purchase
      );
    }
  });

  tx();
  return getCapacityObligations(month);
}

function getCapacityObligations(month, participantId = null) {
  if (!isValidMonth(month)) throw new Error('月份格式应为 YYYY-MM');

  let sql = `
    SELECT co.*, p.code, p.name, p.type
    FROM capacity_obligations co
    JOIN market_participants p ON co.participant_id = p.id
    WHERE co.month = ?
  `;
  const params = [month];

  if (participantId) {
    sql += ' AND co.participant_id = ?';
    params.push(participantId);
  }

  sql += ' ORDER BY p.code';
  const rows = db.prepare(sql).all(...params);

  if (participantId && rows.length === 0) return null;

  const demand = getMonthlyDemand(month);
  return {
    month,
    total_demand_mw: demand ? demand.total_demand_mw : 0,
    peak_load_forecast: demand ? demand.peak_load_forecast : 0,
    reserve_margin: demand ? demand.reserve_margin : 0,
    obligations: rows
  };
}

function openBiddingSession(month, bidStartTime, bidEndTime) {
  if (!isValidMonth(month)) throw new Error('月份格式应为 YYYY-MM');

  const existing = db.prepare('SELECT id FROM capacity_bidding_sessions WHERE month = ?').get(month);
  if (existing) {
    const session = db.prepare('SELECT * FROM capacity_bidding_sessions WHERE month = ?').get(month);
    if (session.status === 'cleared') throw new Error('本月已完成出清，不能重新开放竞标');
    db.prepare(`
      UPDATE capacity_bidding_sessions
      SET status = 'bidding', bid_start_time = ?, bid_end_time = ?
      WHERE month = ?
    `).run(bidStartTime || new Date().toISOString(), bidEndTime || null, month);
  } else {
    db.prepare(`
      INSERT INTO capacity_bidding_sessions
      (id, month, status, bid_start_time, bid_end_time)
      VALUES (?, ?, 'bidding', ?, ?)
    `).run(uuidv4(), month, bidStartTime || new Date().toISOString(), bidEndTime || null);
  }

  return getBiddingSession(month);
}

function closeBiddingSession(month) {
  if (!isValidMonth(month)) throw new Error('月份格式应为 YYYY-MM');

  const session = db.prepare('SELECT * FROM capacity_bidding_sessions WHERE month = ?').get(month);
  if (!session) throw new Error('竞标会话不存在');
  if (session.status === 'cleared') throw new Error('本月已完成出清');

  db.prepare("UPDATE capacity_bidding_sessions SET status = 'closed' WHERE month = ?").run(month);
  return getBiddingSession(month);
}

function getBiddingSession(month) {
  if (!isValidMonth(month)) throw new Error('月份格式应为 YYYY-MM');
  const session = db.prepare('SELECT * FROM capacity_bidding_sessions WHERE month = ?').get(month);
  if (!session) return null;

  const bids = db.prepare(`
    SELECT cb.*, p.code, p.name, p.installed_capacity
    FROM capacity_bids cb
    JOIN market_participants p ON cb.participant_id = p.id
    WHERE cb.month = ?
    ORDER BY cb.price_yuan_per_mw_month ASC
  `).all(month);

  return {
    ...session,
    bids
  };
}

function submitCapacityBid(month, participantId, offeredCapacityMw, priceYuanPerMwMonth) {
  if (!isValidMonth(month)) throw new Error('月份格式应为 YYYY-MM');
  if (offeredCapacityMw == null || offeredCapacityMw <= 0) throw new Error('申报容量必须大于0');
  if (priceYuanPerMwMonth == null || priceYuanPerMwMonth < 0) throw new Error('报价不能为负');

  const session = db.prepare('SELECT * FROM capacity_bidding_sessions WHERE month = ?').get(month);
  if (!session) throw new Error('竞标会话不存在');
  if (session.status !== 'bidding') throw new Error('当前不在竞标窗口期');

  const p = getParticipantById(participantId);
  if (!p) throw new Error('市场主体不存在');
  if (p.type !== 'generator') throw new Error('只有电厂可以提交容量竞标');

  const activeContracts = db.prepare(`
    SELECT SUM(total_energy) as total_energy
    FROM mid_long_term_contracts
    WHERE seller_id = ? AND status = 'active'
    AND (termination_date IS NULL OR termination_date >= date('now'))
  `).get(participantId);

  const contractedCapacityMw = activeContracts && activeContracts.total_energy
    ? activeContracts.total_energy / (30 * 24)
    : 0;

  const maxOfferCapacity = p.installed_capacity - contractedCapacityMw;
  if (offeredCapacityMw > maxOfferCapacity) {
    throw new Error(`申报容量(${offeredCapacityMw}MW)超过可用上限(${maxOfferCapacity.toFixed(2)}MW)`);
  }

  const tx = db.transaction(() => {
    db.prepare(`
      DELETE FROM capacity_bids
      WHERE session_id = ? AND participant_id = ?
    `).run(session.id, participantId);

    db.prepare(`
      INSERT INTO capacity_bids
      (id, session_id, month, participant_id, offered_capacity_mw,
       price_yuan_per_mw_month, max_offer_capacity_mw, contracted_capacity_mw)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      uuidv4(), session.id, month, participantId,
      offeredCapacityMw, priceYuanPerMwMonth, maxOfferCapacity, contractedCapacityMw
    );
  });

  tx();
  return getParticipantBid(month, participantId);
}

function getParticipantBid(month, participantId) {
  if (!isValidMonth(month)) throw new Error('月份格式应为 YYYY-MM');

  const bid = db.prepare(`
    SELECT cb.*, p.code, p.name, p.installed_capacity
    FROM capacity_bids cb
    JOIN market_participants p ON cb.participant_id = p.id
    WHERE cb.month = ? AND cb.participant_id = ?
  `).get(month, participantId);

  return bid || null;
}

function executeCapacityClearing(month) {
  if (!isValidMonth(month)) throw new Error('月份格式应为 YYYY-MM');

  const demand = getMonthlyDemand(month);
  if (!demand) throw new Error('请先设定本月总容量需求');

  const session = db.prepare('SELECT * FROM capacity_bidding_sessions WHERE month = ?').get(month);
  if (!session) throw new Error('竞标会话不存在');
  if (session.status === 'cleared') throw new Error('本月已完成出清');
  if (session.status === 'bidding') throw new Error('请先关闭竞标窗口再执行出清');

  const existingClearing = db.prepare('SELECT id FROM capacity_clearing_results WHERE month = ?').get(month);
  if (existingClearing) throw new Error('本月已完成容量出清');

  const bids = db.prepare(`
    SELECT cb.*, p.code, p.name, p.installed_capacity
    FROM capacity_bids cb
    JOIN market_participants p ON cb.participant_id = p.id
    WHERE cb.month = ?
    ORDER BY cb.price_yuan_per_mw_month ASC
  `).all(month);

  if (bids.length === 0) throw new Error('没有收到任何容量竞标');

  let accumulatedCapacity = 0;
  let clearingPrice = 0;
  const winners = [];
  const totalDemand = demand.total_demand_mw;

  for (const bid of bids) {
    if (accumulatedCapacity >= totalDemand) break;

    const needed = totalDemand - accumulatedCapacity;
    const allocated = Math.min(bid.offered_capacity_mw, needed);

    winners.push({
      participant_id: bid.participant_id,
      code: bid.code,
      name: bid.name,
      committed_capacity_mw: allocated,
      bid_price: bid.price_yuan_per_mw_month
    });

    accumulatedCapacity += allocated;
    clearingPrice = bid.price_yuan_per_mw_month;
  }

  if (winners.length === 0 || accumulatedCapacity <= 0) {
    throw new Error('没有足够的容量竞标满足系统需求');
  }

  if (accumulatedCapacity < totalDemand) {
    console.warn(`[CapacityMarket] 警告: 中标总容量(${accumulatedCapacity}MW)小于系统需求(${totalDemand}MW)`);
  }

  const tx = db.transaction(() => {
    const clearingResultId = uuidv4();
    db.prepare(`
      INSERT INTO capacity_clearing_results
      (id, month, clearing_price_yuan_per_mw, total_cleared_capacity_mw, total_demand_mw)
      VALUES (?, ?, ?, ?, ?)
    `).run(clearingResultId, month, clearingPrice, accumulatedCapacity, totalDemand);

    const insertAlloc = db.prepare(`
      INSERT INTO capacity_clearing_allocations
      (id, clearing_result_id, participant_id, month, committed_capacity_mw,
       clearing_price_yuan_per_mw, monthly_compensation_yuan, is_winner)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `);

    for (const winner of winners) {
      const compensation = winner.committed_capacity_mw * clearingPrice;
      insertAlloc.run(
        uuidv4(), clearingResultId, winner.participant_id, month,
        winner.committed_capacity_mw, clearingPrice, compensation
      );
    }

    db.prepare("UPDATE capacity_bidding_sessions SET status = 'cleared' WHERE month = ?").run(month);
  });

  tx();
  return getClearingResult(month);
}

function getClearingResult(month) {
  if (!isValidMonth(month)) throw new Error('月份格式应为 YYYY-MM');

  const result = db.prepare('SELECT * FROM capacity_clearing_results WHERE month = ?').get(month);
  if (!result) return null;

  const allocations = db.prepare(`
    SELECT cca.*, p.code, p.name, p.installed_capacity
    FROM capacity_clearing_allocations cca
    JOIN market_participants p ON cca.participant_id = p.id
    WHERE cca.month = ? AND cca.is_winner = 1
    ORDER BY p.code
  `).all(month);

  return {
    ...result,
    winners: allocations
  };
}

function getClearingResultByParticipant(month, participantId) {
  if (!isValidMonth(month)) throw new Error('月份格式应为 YYYY-MM');

  const result = db.prepare('SELECT * FROM capacity_clearing_results WHERE month = ?').get(month);
  if (!result) return null;

  const allocation = db.prepare(`
    SELECT cca.*, p.code, p.name, p.installed_capacity
    FROM capacity_clearing_allocations cca
    JOIN market_participants p ON cca.participant_id = p.id
    WHERE cca.month = ? AND cca.participant_id = ? AND cca.is_winner = 1
  `).get(month, participantId);

  if (!allocation) {
    return {
      month,
      clearing_price_yuan_per_mw: result.clearing_price_yuan_per_mw,
      participant_id: participantId,
      is_winner: false,
      committed_capacity_mw: 0,
      monthly_compensation_yuan: 0
    };
  }

  return {
    month,
    clearing_price_yuan_per_mw: result.clearing_price_yuan_per_mw,
    ...allocation
  };
}

function checkCapacityAvailability(tradingDayId) {
  const td = getTradingDayById(tradingDayId);
  if (!td) throw new Error('交易日不存在');
  if (td.status !== 'cleared') throw new Error('该交易日尚未出清');

  const month = td.trade_date.substring(0, 7);
  const clearingResult = db.prepare('SELECT id FROM capacity_clearing_results WHERE month = ?').get(month);
  if (!clearingResult) return { checked: false, reason: '本月尚未完成容量出清' };

  const winners = db.prepare(`
    SELECT cca.participant_id, cca.committed_capacity_mw, p.installed_capacity
    FROM capacity_clearing_allocations cca
    JOIN market_participants p ON cca.participant_id = p.id
    WHERE cca.month = ? AND cca.is_winner = 1
  `).all(month);

  const shortageEvents = [];

  const tx = db.transaction(() => {
    const insertStmt = db.prepare(`
      INSERT OR IGNORE INTO capacity_shortage_events
      (id, month, participant_id, trading_day_id, trade_date, hour,
       committed_capacity_mw, actual_available_mw, shortage_mw)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const winner of winners) {
      const committed = winner.committed_capacity_mw;
      const installed = winner.installed_capacity;

      for (let hour = 0; hour < 24; hour++) {
        const actualAvailable = installed;

        if (actualAvailable < committed) {
          const shortage = committed - actualAvailable;
          const result = insertStmt.run(
            uuidv4(), month, winner.participant_id, tradingDayId,
            td.trade_date, hour, committed, actualAvailable, shortage
          );

          if (result.changes > 0) {
            shortageEvents.push({
              participant_id: winner.participant_id,
              hour,
              committed_capacity_mw: committed,
              actual_available_mw: actualAvailable,
              shortage_mw: shortage
            });
          }
        }
      }
    }
  });

  tx();

  return {
    checked: true,
    trading_day_id: tradingDayId,
    trade_date: td.trade_date,
    month,
    total_winners_checked: winners.length,
    new_shortage_events: shortageEvents.length,
    shortage_events: shortageEvents
  };
}

function getShortageEvents(month, participantId = null) {
  if (!isValidMonth(month)) throw new Error('月份格式应为 YYYY-MM');

  let sql = `
    SELECT cse.*, p.code, p.name
    FROM capacity_shortage_events cse
    JOIN market_participants p ON cse.participant_id = p.id
    WHERE cse.month = ?
  `;
  const params = [month];

  if (participantId) {
    sql += ' AND cse.participant_id = ?';
    params.push(participantId);
  }

  sql += ' ORDER BY cse.trade_date, cse.hour, p.code';
  return db.prepare(sql).all(...params);
}

function calculateAvailabilityAssessment(month) {
  if (!isValidMonth(month)) throw new Error('月份格式应为 YYYY-MM');

  const clearingResult = db.prepare('SELECT * FROM capacity_clearing_results WHERE month = ?').get(month);
  if (!clearingResult) throw new Error('本月尚未完成容量出清');

  const tradingDays = listTradingDays();
  const monthTradingDays = tradingDays.filter(td => td.trade_date.startsWith(month) && td.status === 'cleared');
  const totalPeriods = monthTradingDays.length * 24;

  if (totalPeriods === 0) throw new Error('本月没有已出清的交易日');

  const winners = db.prepare(`
    SELECT cca.*, p.code, p.name
    FROM capacity_clearing_allocations cca
    JOIN market_participants p ON cca.participant_id = p.id
    WHERE cca.month = ? AND cca.is_winner = 1
  `).all(month);

  const shortageCounts = db.prepare(`
    SELECT participant_id, COUNT(*) as shortage_count
    FROM capacity_shortage_events
    WHERE month = ?
    GROUP BY participant_id
  `).all(month);

  const shortageMap = {};
  for (const sc of shortageCounts) {
    shortageMap[sc.participant_id] = sc.shortage_count;
  }

  const assessments = [];

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM capacity_availability_assessments WHERE month = ?').run(month);

    const insertStmt = db.prepare(`
      INSERT INTO capacity_availability_assessments
      (id, month, participant_id, committed_capacity_mw, total_required_periods,
       available_periods, availability_rate, threshold_rate, is_compliant,
       original_compensation, deduction_ratio, deduction_amount, final_compensation)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const winner of winners) {
      const shortagePeriods = shortageMap[winner.participant_id] || 0;
      const availablePeriods = totalPeriods - shortagePeriods;
      const availabilityRate = totalPeriods > 0 ? availablePeriods / totalPeriods : 1;
      const isCompliant = availabilityRate >= AVAILABILITY_THRESHOLD;

      let deductionRatio = 0;
      let deductionAmount = 0;

      if (!isCompliant) {
        deductionRatio = Math.min(1, (AVAILABILITY_THRESHOLD - availabilityRate) / 0.05);
        deductionAmount = winner.monthly_compensation_yuan * deductionRatio;
      }

      const finalCompensation = winner.monthly_compensation_yuan - deductionAmount;

      insertStmt.run(
        uuidv4(), month, winner.participant_id, winner.committed_capacity_mw,
        totalPeriods, availablePeriods, availabilityRate, AVAILABILITY_THRESHOLD,
        isCompliant ? 1 : 0, winner.monthly_compensation_yuan,
        deductionRatio, deductionAmount, finalCompensation
      );

      assessments.push({
        participant_id: winner.participant_id,
        code: winner.code,
        name: winner.name,
        committed_capacity_mw: winner.committed_capacity_mw,
        total_required_periods: totalPeriods,
        available_periods: availablePeriods,
        shortage_periods: shortagePeriods,
        availability_rate: availabilityRate,
        is_compliant: isCompliant,
        original_compensation: winner.monthly_compensation_yuan,
        deduction_ratio: deductionRatio,
        deduction_amount: deductionAmount,
        final_compensation: finalCompensation
      });
    }
  });

  tx();
  return getAvailabilityAssessments(month);
}

function getAvailabilityAssessments(month, participantId = null) {
  if (!isValidMonth(month)) throw new Error('月份格式应为 YYYY-MM');

  let sql = `
    SELECT caa.*, p.code, p.name
    FROM capacity_availability_assessments caa
    JOIN market_participants p ON caa.participant_id = p.id
    WHERE caa.month = ?
  `;
  const params = [month];

  if (participantId) {
    sql += ' AND caa.participant_id = ?';
    params.push(participantId);
  }

  sql += ' ORDER BY p.code';
  const rows = db.prepare(sql).all(...params);

  if (participantId && rows.length === 0) return null;

  return {
    month,
    threshold_rate: AVAILABILITY_THRESHOLD,
    assessments: rows
  };
}

function generateMonthlySettlement(month) {
  if (!isValidMonth(month)) throw new Error('月份格式应为 YYYY-MM');

  const existingSettlement = db.prepare('SELECT id FROM capacity_settlements WHERE month = ?').get(month);
  if (existingSettlement) throw new Error('本月结算单已生成');

  const assessments = getAvailabilityAssessments(month);
  if (!assessments || assessments.assessments.length === 0) {
    throw new Error('请先完成本月可用性考核');
  }

  const obligations = getCapacityObligations(month);
  if (!obligations || obligations.obligations.length === 0) {
    throw new Error('请先生成本月容量义务分配');
  }

  let totalCompensation = 0;
  let totalDeduction = 0;

  for (const a of assessments.assessments) {
    totalCompensation += a.original_compensation;
    totalDeduction += a.deduction_amount;
  }

  const netPayable = totalCompensation - totalDeduction;

  const tx = db.transaction(() => {
    const settlementId = uuidv4();
    db.prepare(`
      INSERT INTO capacity_settlements
      (id, month, total_compensation, total_deduction, net_payable)
      VALUES (?, ?, ?, ?, ?)
    `).run(settlementId, month, totalCompensation, totalDeduction, netPayable);

    const insertItem = db.prepare(`
      INSERT INTO capacity_settlement_items
      (id, settlement_id, participant_id, month, role, obligation_mw,
       committed_capacity_mw, share_ratio, original_amount, deduction_amount, net_amount)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const a of assessments.assessments) {
      insertItem.run(
        uuidv4(), settlementId, a.participant_id, month, 'generator',
        null, a.committed_capacity_mw, null,
        a.original_compensation, a.deduction_amount, a.final_compensation
      );
    }

    const totalObligation = obligations.obligations.reduce((sum, o) => sum + o.obligation_mw, 0);
    for (const o of obligations.obligations) {
      const shareRatio = totalObligation > 0 ? o.obligation_mw / totalObligation : 0;
      const payableAmount = netPayable * shareRatio;
      insertItem.run(
        uuidv4(), settlementId, o.participant_id, month, 'consumer',
        o.obligation_mw, null, shareRatio,
        payableAmount, 0, payableAmount
      );
    }
  });

  tx();
  return getSettlement(month);
}

function getSettlement(month) {
  if (!isValidMonth(month)) throw new Error('月份格式应为 YYYY-MM');

  const settlement = db.prepare('SELECT * FROM capacity_settlements WHERE month = ?').get(month);
  if (!settlement) return null;

  const items = db.prepare(`
    SELECT csi.*, p.code, p.name, p.type
    FROM capacity_settlement_items csi
    JOIN market_participants p ON csi.participant_id = p.id
    WHERE csi.settlement_id = ?
    ORDER BY p.type, p.code
  `).all(settlement.id);

  const assessments = db.prepare(`
    SELECT participant_id, availability_rate, total_required_periods, available_periods, is_compliant
    FROM capacity_availability_assessments
    WHERE month = ?
  `).all(month);

  const assessmentMap = {};
  for (const a of assessments) {
    assessmentMap[a.participant_id] = {
      ...a,
      shortage_periods: a.total_required_periods - a.available_periods
    };
  }

  const generators = items.filter(i => i.role === 'generator').map(i => ({
    participant_id: i.participant_id,
    code: i.code,
    name: i.name,
    role: i.role,
    capacity_mw: i.committed_capacity_mw,
    total_compensation: i.original_amount,
    total_deduction: i.deduction_amount,
    net_compensation: i.net_amount,
    availability_rate: assessmentMap[i.participant_id]?.availability_rate,
    total_required_periods: assessmentMap[i.participant_id]?.total_required_periods,
    available_periods: assessmentMap[i.participant_id]?.available_periods,
    shortage_periods: assessmentMap[i.participant_id]?.shortage_periods,
    is_compliant: assessmentMap[i.participant_id]?.is_compliant
  }));

  const consumers = items.filter(i => i.role === 'consumer').map(i => ({
    participant_id: i.participant_id,
    code: i.code,
    name: i.name,
    role: i.role,
    obligation_mw: i.obligation_mw,
    share_ratio: i.share_ratio,
    total_payable: i.original_amount,
    deduction_amount: i.deduction_amount,
    net_amount: i.net_amount
  }));

  return {
    ...settlement,
    generator_settlements: generators,
    consumer_settlements: consumers,
    all_items: items
  };
}

function getClearingPriceHistory() {
  const rows = db.prepare(`
    SELECT month, clearing_price_yuan_per_mw, total_cleared_capacity_mw, total_demand_mw
    FROM capacity_clearing_results
    ORDER BY month ASC
  `).all();

  return rows;
}

module.exports = {
  setMonthlyDemand,
  getMonthlyDemand,
  allocateCapacityObligations,
  getCapacityObligations,
  openBiddingSession,
  closeBiddingSession,
  getBiddingSession,
  submitCapacityBid,
  getParticipantBid,
  executeCapacityClearing,
  getClearingResult,
  getClearingResultByParticipant,
  checkCapacityAvailability,
  getShortageEvents,
  calculateAvailabilityAssessment,
  getAvailabilityAssessments,
  generateMonthlySettlement,
  getSettlement,
  getClearingPriceHistory
};
