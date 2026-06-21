const { v4: uuidv4 } = require('uuid');
const db = require('../utils/db');
const { listParticipants, getParticipantById } = require('./participantService');

const INITIAL_CREDIT_SCORE = 70;
const MAX_SETTLEMENT_TIMELINESS_SCORE = 30;
const MAX_DEVIATION_CONTROL_SCORE = 25;
const MAX_CONTRACT_PERFORMANCE_SCORE = 25;
const MAX_VIOLATION_SCORE = 20;
const DEVIATION_THRESHOLD = 0.1;
const DEVIATION_PENALTY_STEP = 0.05;
const DEVIATION_PENALTY_POINTS = 5;
const CONTRACT_PERFORMANCE_THRESHOLD = 0.9;
const CONTRACT_PENALTY_STEP = 0.05;
const CONTRACT_PENALTY_POINTS = 5;
const VIOLATION_PENALTY_POINTS = 4;

function getCreditLevel(score) {
  if (score >= 90) return 'AAA';
  if (score >= 75) return 'AA';
  if (score >= 60) return 'A';
  return 'B';
}

function getMarginRatio(level) {
  switch (level) {
    case 'AAA': return 0.05;
    case 'AA': return 0.10;
    case 'A': return 0.15;
    case 'B': return 0.25;
    default: return 0.15;
  }
}

function _getPast3Months(monthStr) {
  const [year, month] = monthStr.split('-').map(Number);
  const months = [];
  for (let i = 0; i < 3; i++) {
    const d = new Date(year, month - 1 - i, 1);
    months.push(d.toISOString().slice(0, 7));
  }
  return months;
}

function _getPast3MonthsTradingDays(monthStr) {
  const months = _getPast3Months(monthStr);
  const rows = db.prepare(`
    SELECT id, trade_date FROM trading_days
    WHERE strftime('%Y-%m', trade_date) IN (${months.map(() => '?').join(', ')})
    AND status IN ('cleared', 'settled')
    ORDER BY trade_date
  `).all(...months);
  return rows;
}

function calculateSettlementTimeliness(participantId, monthStr) {
  const months = _getPast3Months(monthStr);
  const rows = db.prepare(`
    SELECT DISTINCT sd.trading_day_id
    FROM settlement_details sd
    JOIN trading_days td ON sd.trading_day_id = td.id
    WHERE sd.participant_id = ?
    AND strftime('%Y-%m', td.trade_date) IN (${months.map(() => '?').join(', ')})
  `).all(participantId, ...months);

  const totalSettlements = rows.length;
  if (totalSettlements === 0) {
    return { ratio: 1, score: MAX_SETTLEMENT_TIMELINESS_SCORE };
  }

  const disputeRows = db.prepare(`
    SELECT COUNT(DISTINCT sd.trading_day_id) as count
    FROM settlement_details sd
    JOIN settlement_disputes disp ON sd.trading_day_id = disp.trading_day_id 
      AND sd.participant_id = disp.participant_id
    WHERE sd.participant_id = ?
    AND disp.status != 'rejected'
    AND strftime('%Y-%m', (SELECT trade_date FROM trading_days WHERE id = sd.trading_day_id)) IN (${months.map(() => '?').join(', ')})
  `).get(participantId, ...months);

  const disputedCount = disputeRows?.count || 0;
  const ratio = (totalSettlements - disputedCount) / totalSettlements;
  const score = Math.round(ratio * MAX_SETTLEMENT_TIMELINESS_SCORE * 100) / 100;

  return { ratio, score };
}

function calculateDeviationControl(participantId, monthStr) {
  const tradingDays = _getPast3MonthsTradingDays(monthStr);
  if (tradingDays.length === 0) {
    return { avgDeviation: 0, score: MAX_DEVIATION_CONTROL_SCORE };
  }

  const dayIds = tradingDays.map(td => td.id);
  const rows = db.prepare(`
    SELECT 
      av.trading_day_id,
      av.hour,
      av.actual_volume,
      ca.final_dispatch
    FROM actual_volumes av
    LEFT JOIN clearing_results cr 
      ON av.trading_day_id = cr.trading_day_id 
      AND av.hour = cr.hour
    LEFT JOIN clearing_allocations ca 
      ON cr.id = ca.clearing_result_id 
      AND av.participant_id = ca.participant_id
    WHERE av.participant_id = ?
    AND av.trading_day_id IN (${dayIds.map(() => '?').join(', ')})
  `).all(participantId, ...dayIds);

  const participant = getParticipantById(participantId);
  const capacity = participant?.type === 'generator' 
    ? participant.installed_capacity 
    : participant?.contracted_capacity || 0;

  if (capacity === 0 || rows.length === 0) {
    return { avgDeviation: 0, score: MAX_DEVIATION_CONTROL_SCORE };
  }

  const dayDeviations = {};
  for (const row of rows) {
    if (!dayDeviations[row.trading_day_id]) {
      dayDeviations[row.trading_day_id] = { totalDeviation: 0, count: 0 };
    }
    const expected = row.final_dispatch || 0;
    const actual = row.actual_volume || 0;
    const deviation = expected > 0 ? Math.abs(actual - expected) / capacity : 0;
    dayDeviations[row.trading_day_id].totalDeviation += deviation;
    dayDeviations[row.trading_day_id].count++;
  }

  const dayAvgDeviations = Object.values(dayDeviations).map(d => 
    d.count > 0 ? d.totalDeviation / d.count : 0
  );

  const avgDeviation = dayAvgDeviations.length > 0
    ? dayAvgDeviations.reduce((a, b) => a + b, 0) / dayAvgDeviations.length
    : 0;

  let score = MAX_DEVIATION_CONTROL_SCORE;
  if (avgDeviation > DEVIATION_THRESHOLD) {
    const excessSteps = Math.floor((avgDeviation - DEVIATION_THRESHOLD) / DEVIATION_PENALTY_STEP) + 1;
    score = Math.max(0, MAX_DEVIATION_CONTROL_SCORE - excessSteps * DEVIATION_PENALTY_POINTS);
  }

  return { avgDeviation, score: Math.round(score * 100) / 100 };
}

function calculateContractPerformance(participantId, monthStr) {
  const months = _getPast3Months(monthStr);
  const participant = getParticipantById(participantId);
  const isSeller = participant?.type === 'generator';

  const rows = db.prepare(`
    SELECT 
      cdr.contract_id,
      cdr.decomposed_energy,
      cdr.trade_date,
      cdr.hour,
      cdr.buyer_id,
      cdr.seller_id,
      av.actual_volume
    FROM contract_decomposition_results cdr
    LEFT JOIN actual_volumes av 
      ON cdr.trade_date = (SELECT trade_date FROM trading_days WHERE id = av.trading_day_id)
      AND av.participant_id = ?
      AND cdr.hour = av.hour
    WHERE (cdr.buyer_id = ? OR cdr.seller_id = ?)
    AND strftime('%Y-%m', cdr.trade_date) IN (${months.map(() => '?').join(', ')})
  `).all(participantId, participantId, participantId, ...months);

  if (rows.length === 0) {
    return { ratio: 1, score: MAX_CONTRACT_PERFORMANCE_SCORE };
  }

  let totalContractEnergy = 0;
  let totalActualEnergy = 0;

  for (const row of rows) {
    const isParticipantSeller = row.seller_id === participantId;
    totalContractEnergy += row.decomposed_energy;
    
    if (isParticipantSeller) {
      totalActualEnergy += row.actual_volume || 0;
    } else {
      totalActualEnergy += row.decomposed_energy;
    }
  }

  const ratio = totalContractEnergy > 0 ? Math.min(1, totalActualEnergy / totalContractEnergy) : 1;
  let score = MAX_CONTRACT_PERFORMANCE_SCORE;
  
  if (ratio < CONTRACT_PERFORMANCE_THRESHOLD) {
    const deficitSteps = Math.floor((CONTRACT_PERFORMANCE_THRESHOLD - ratio) / CONTRACT_PENALTY_STEP) + 1;
    score = Math.max(0, MAX_CONTRACT_PERFORMANCE_SCORE - deficitSteps * CONTRACT_PENALTY_POINTS);
  }

  return { ratio, score: Math.round(score * 100) / 100 };
}

function calculateViolationScore(participantId, monthStr) {
  const months = _getPast3Months(monthStr);
  const row = db.prepare(`
    SELECT COUNT(*) as count
    FROM supervision_anomalies
    WHERE participant_id = ?
    AND strftime('%Y-%m', trade_date) IN (${months.map(() => '?').join(', ')})
  `).get(participantId, ...months);

  const violationCount = row?.count || 0;
  const score = Math.max(0, MAX_VIOLATION_SCORE - violationCount * VIOLATION_PENALTY_POINTS);

  return { count: violationCount, score };
}

function _shouldBeRestricted(score, prev1, prev2) {
  if (score >= 60) return 0;
  if (score < 50) return 1;
  if (prev1 && prev2 && prev1.score < 50 && prev2.score < 50) return 1;
  return 0;
}

function calculateCreditScore(participantId, monthStr) {
  const settlement = calculateSettlementTimeliness(participantId, monthStr);
  const deviation = calculateDeviationControl(participantId, monthStr);
  const contract = calculateContractPerformance(participantId, monthStr);
  const violation = calculateViolationScore(participantId, monthStr);

  const totalScore = Math.min(100, Math.max(0, 
    settlement.score + deviation.score + contract.score + violation.score
  ));

  const level = getCreditLevel(totalScore);

  const prevMonth = new Date(monthStr + '-01');
  prevMonth.setMonth(prevMonth.getMonth() - 1);
  const prevMonthStr = prevMonth.toISOString().slice(0, 7);
  
  const prevMonth2 = new Date(monthStr + '-01');
  prevMonth2.setMonth(prevMonth2.getMonth() - 2);
  const prevMonth2Str = prevMonth2.toISOString().slice(0, 7);

  const prevScores = db.prepare(`
    SELECT month, score FROM credit_scores
    WHERE participant_id = ? AND month IN (?, ?)
    ORDER BY month DESC
  `).all(participantId, prevMonthStr, prevMonth2Str);

  const prev1 = prevScores.find(s => s.month === prevMonthStr);
  const prev2 = prevScores.find(s => s.month === prevMonth2Str);
  
  const tradingRestricted = _shouldBeRestricted(totalScore, prev1, prev2);

  return {
    score: Math.round(totalScore * 100) / 100,
    level,
    settlement_timeliness: Math.round(settlement.ratio * 10000) / 10000,
    settlement_timeliness_score: settlement.score,
    deviation_control: Math.round(deviation.avgDeviation * 10000) / 10000,
    deviation_control_score: deviation.score,
    contract_performance: Math.round(contract.ratio * 10000) / 10000,
    contract_performance_score: contract.score,
    violation_count: violation.count,
    violation_score: violation.score,
    trading_restricted: tradingRestricted
  };
}

function recalculateAllCreditScores(monthStr = null) {
  const targetMonth = monthStr || new Date().toISOString().slice(0, 7);
  const participants = listParticipants();

  const tx = db.transaction(() => {
    const upsertStmt = db.prepare(`
      INSERT INTO credit_scores 
      (id, participant_id, month, score, level, settlement_timeliness, settlement_timeliness_score,
       deviation_control, deviation_control_score, contract_performance, contract_performance_score,
       violation_count, violation_score, trading_restricted, manually_adjusted)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(participant_id, month) DO UPDATE SET
        score = excluded.score,
        level = excluded.level,
        settlement_timeliness = excluded.settlement_timeliness,
        settlement_timeliness_score = excluded.settlement_timeliness_score,
        deviation_control = excluded.deviation_control,
        deviation_control_score = excluded.deviation_control_score,
        contract_performance = excluded.contract_performance,
        contract_performance_score = excluded.contract_performance_score,
        violation_count = excluded.violation_count,
        violation_score = excluded.violation_score,
        trading_restricted = excluded.trading_restricted
      WHERE credit_scores.manually_adjusted = 0
    `);

    const updateFactorsOnlyStmt = db.prepare(`
      UPDATE credit_scores SET
        settlement_timeliness = ?,
        settlement_timeliness_score = ?,
        deviation_control = ?,
        deviation_control_score = ?,
        contract_performance = ?,
        contract_performance_score = ?,
        violation_count = ?,
        violation_score = ?
      WHERE participant_id = ? AND month = ? AND manually_adjusted = 1
    `);

    const results = [];
    for (const p of participants) {
      const creditData = calculateCreditScore(p.id, targetMonth);
      const existing = db.prepare(`
        SELECT id, manually_adjusted FROM credit_scores WHERE participant_id = ? AND month = ?
      `).get(p.id, targetMonth);
      
      const id = existing?.id || uuidv4();
      const isManual = existing?.manually_adjusted === 1;
      
      if (isManual) {
        updateFactorsOnlyStmt.run(
          creditData.settlement_timeliness, creditData.settlement_timeliness_score,
          creditData.deviation_control, creditData.deviation_control_score,
          creditData.contract_performance, creditData.contract_performance_score,
          creditData.violation_count, creditData.violation_score,
          p.id, targetMonth
        );
        const updated = db.prepare(`SELECT * FROM credit_scores WHERE id = ?`).get(id);
        results.push({ 
          participant_id: p.id, 
          manually_adjusted: 1,
          score: updated.score,
          level: updated.level,
          trading_restricted: updated.trading_restricted,
          settlement_timeliness: updated.settlement_timeliness,
          settlement_timeliness_score: updated.settlement_timeliness_score,
          deviation_control: updated.deviation_control,
          deviation_control_score: updated.deviation_control_score,
          contract_performance: updated.contract_performance,
          contract_performance_score: updated.contract_performance_score,
          violation_count: updated.violation_count,
          violation_score: updated.violation_score
        });
      } else {
        upsertStmt.run(
          id, p.id, targetMonth,
          creditData.score, creditData.level,
          creditData.settlement_timeliness, creditData.settlement_timeliness_score,
          creditData.deviation_control, creditData.deviation_control_score,
          creditData.contract_performance, creditData.contract_performance_score,
          creditData.violation_count, creditData.violation_score,
          creditData.trading_restricted
        );
        results.push({ participant_id: p.id, ...creditData, manually_adjusted: 0 });
      }
    }
    return results;
  });

  return tx();
}

function getCurrentCreditScore(participantId) {
  const currentMonth = new Date().toISOString().slice(0, 7);
  let score = db.prepare(`
    SELECT * FROM credit_scores WHERE participant_id = ? AND month = ?
  `).get(participantId, currentMonth);

  if (!score) {
    const data = calculateCreditScore(participantId, currentMonth);
    db.prepare(`
      INSERT INTO credit_scores 
      (id, participant_id, month, score, level, settlement_timeliness, settlement_timeliness_score,
       deviation_control, deviation_control_score, contract_performance, contract_performance_score,
       violation_count, violation_score, trading_restricted, manually_adjusted)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(
      uuidv4(), participantId, currentMonth,
      data.score, data.level,
      data.settlement_timeliness, data.settlement_timeliness_score,
      data.deviation_control, data.deviation_control_score,
      data.contract_performance, data.contract_performance_score,
      data.violation_count, data.violation_score,
      data.trading_restricted
    );
    score = db.prepare(`
      SELECT * FROM credit_scores WHERE participant_id = ? AND month = ?
    `).get(participantId, currentMonth);
  }

  const participant = getParticipantById(participantId);
  return {
    ...score,
    participant_code: participant?.code,
    participant_name: participant?.name,
    participant_type: participant?.type,
    margin_ratio: getMarginRatio(score.level)
  };
}

function getCreditRanking(limit = 10) {
  const currentMonth = new Date().toISOString().slice(0, 7);
  const rows = db.prepare(`
    SELECT cs.*, p.code, p.name, p.type
    FROM credit_scores cs
    JOIN market_participants p ON cs.participant_id = p.id
    WHERE cs.month = ?
    ORDER BY cs.score DESC
    LIMIT ?
  `).all(currentMonth, limit);

  return rows.map((row, idx) => ({
    rank: idx + 1,
    participant_id: row.participant_id,
    participant_code: row.code,
    participant_name: row.name,
    participant_type: row.type,
    score: row.score,
    level: row.level,
    margin_ratio: getMarginRatio(row.level),
    trading_restricted: row.trading_restricted
  }));
}

function adjustCreditScore(participantId, monthStr, newScore, reason, operator) {
  if (!monthStr) {
    monthStr = new Date().toISOString().slice(0, 7);
  }
  if (newScore < 0 || newScore > 100) {
    throw new Error('信用分必须在 0-100 之间');
  }
  if (!reason || !reason.trim()) {
    throw new Error('调整原因不能为空');
  }
  if (!operator || !operator.trim()) {
    throw new Error('操作人不能为空');
  }

  const participant = getParticipantById(participantId);
  if (!participant) {
    throw new Error('市场主体不存在');
  }

  const tx = db.transaction(() => {
    let existing = db.prepare(`
      SELECT * FROM credit_scores WHERE participant_id = ? AND month = ?
    `).get(participantId, monthStr);

    if (!existing) {
      const initData = calculateCreditScore(participantId, monthStr);
      db.prepare(`
        INSERT INTO credit_scores 
        (id, participant_id, month, score, level, settlement_timeliness, settlement_timeliness_score,
         deviation_control, deviation_control_score, contract_performance, contract_performance_score,
         violation_count, violation_score, trading_restricted, manually_adjusted)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      `).run(
        uuidv4(), participantId, monthStr,
        initData.score, initData.level,
        initData.settlement_timeliness, initData.settlement_timeliness_score,
        initData.deviation_control, initData.deviation_control_score,
        initData.contract_performance, initData.contract_performance_score,
        initData.violation_count, initData.violation_score,
        initData.trading_restricted
      );
      existing = db.prepare(`
        SELECT * FROM credit_scores WHERE participant_id = ? AND month = ?
      `).get(participantId, monthStr);
    }

    const level = getCreditLevel(newScore);
    const prevMonth = new Date(monthStr + '-01');
    prevMonth.setMonth(prevMonth.getMonth() - 1);
    const prevMonthStr = prevMonth.toISOString().slice(0, 7);
    
    const prevMonth2 = new Date(monthStr + '-01');
    prevMonth2.setMonth(prevMonth2.getMonth() - 2);
    const prevMonth2Str = prevMonth2.toISOString().slice(0, 7);

    const prevScores = db.prepare(`
      SELECT month, score FROM credit_scores
      WHERE participant_id = ? AND month IN (?, ?)
      ORDER BY month DESC
    `).all(participantId, prevMonthStr, prevMonth2Str);

    const prev1 = prevScores.find(s => s.month === prevMonthStr);
    const prev2 = prevScores.find(s => s.month === prevMonth2Str);
    
    const tradingRestricted = _shouldBeRestricted(newScore, prev1, prev2);

    db.prepare(`
      UPDATE credit_scores 
      SET score = ?, level = ?, trading_restricted = ?, manually_adjusted = 1
      WHERE participant_id = ? AND month = ?
    `).run(newScore, level, tradingRestricted, participantId, monthStr);

    db.prepare(`
      INSERT INTO credit_adjustment_records
      (id, participant_id, month, original_score, adjusted_score, adjustment_reason, operator)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(uuidv4(), participantId, monthStr, existing.score, newScore, reason, operator);

    return {
      participant_id: participantId,
      month: monthStr,
      original_score: existing.score,
      adjusted_score: newScore,
      level,
      trading_restricted: tradingRestricted,
      manually_adjusted: 1
    };
  });

  return tx();
}

function getCreditHistory(participantId, limit = 12) {
  const rows = db.prepare(`
    SELECT cs.*, 
           (SELECT adjustment_reason FROM credit_adjustment_records 
            WHERE participant_id = cs.participant_id AND month = cs.month 
            ORDER BY created_at DESC LIMIT 1) as adjustment_reason
    FROM credit_scores cs
    WHERE cs.participant_id = ?
    ORDER BY cs.month DESC
    LIMIT ?
  `).all(participantId, limit);

  return rows.map(row => ({
    month: row.month,
    score: row.score,
    level: row.level,
    margin_ratio: getMarginRatio(row.level),
    settlement_timeliness: row.settlement_timeliness,
    settlement_timeliness_score: row.settlement_timeliness_score,
    deviation_control: row.deviation_control,
    deviation_control_score: row.deviation_control_score,
    contract_performance: row.contract_performance,
    contract_performance_score: row.contract_performance_score,
    violation_count: row.violation_count,
    violation_score: row.violation_score,
    trading_restricted: row.trading_restricted,
    adjustment_reason: row.adjustment_reason,
    created_at: row.created_at
  }));
}

function isTradingRestricted(participantId) {
  const current = getCurrentCreditScore(participantId);
  return current?.trading_restricted === 1;
}

function getTradingLimitRatio(participantId) {
  const current = getCurrentCreditScore(participantId);
  if (current?.level === 'B') {
    return 0.8;
  }
  return 1.0;
}

module.exports = {
  INITIAL_CREDIT_SCORE,
  getCreditLevel,
  getMarginRatio,
  calculateSettlementTimeliness,
  calculateDeviationControl,
  calculateContractPerformance,
  calculateViolationScore,
  calculateCreditScore,
  recalculateAllCreditScores,
  getCurrentCreditScore,
  getCreditRanking,
  adjustCreditScore,
  getCreditHistory,
  isTradingRestricted,
  getTradingLimitRatio
};
