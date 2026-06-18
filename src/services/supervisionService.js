const { v4: uuidv4 } = require('uuid');
const db = require('../utils/db');
const { getTradingDayById, listTradingDays } = require('./tradingDayService');
const { listParticipants, getParticipantById } = require('./participantService');

function analyzeBiddingBehavior(tradingDayId) {
  const td = getTradingDayById(tradingDayId);
  if (!td) throw new Error('交易日不存在');
  if (td.status === 'bidding') throw new Error('该交易日尚未出清');

  const generators = listParticipants('generator');
  const clearingPrices = db.prepare(`
    SELECT hour, clearing_price FROM clearing_results WHERE trading_day_id = ? ORDER BY hour
  `).all(tradingDayId);

  const priceMap = {};
  for (const cp of clearingPrices) {
    priceMap[cp.hour] = cp.clearing_price;
  }

  const previous7Days = db.prepare(`
    SELECT td.id, td.trade_date FROM trading_days td
    WHERE td.trade_date < ? AND td.status != 'bidding'
    ORDER BY td.trade_date DESC LIMIT 7
  `).all(td.trade_date);

  const avg7DayPrice = {};
  for (let h = 0; h < 24; h++) {
    const prices = [];
    for (const ptd of previous7Days) {
      const row = db.prepare(`
        SELECT clearing_price FROM clearing_results WHERE trading_day_id = ? AND hour = ?
      `).get(ptd.id, h);
      if (row && row.clearing_price > 0) prices.push(row.clearing_price);
    }
    if (prices.length > 0) {
      avg7DayPrice[h] = prices.reduce((a, b) => a + b, 0) / prices.length;
    }
  }

  const anomalies = [];

  for (const gen of generators) {
    const bidsByHour = db.prepare(`
      SELECT hour, segment_index, price, capacity
      FROM generator_bids
      WHERE trading_day_id = ? AND participant_id = ?
      ORDER BY hour, segment_index
    `).all(tradingDayId, gen.id);

    const hourMap = {};
    for (const bid of bidsByHour) {
      if (!hourMap[bid.hour]) hourMap[bid.hour] = [];
      hourMap[bid.hour].push(bid);
    }

    for (let h = 0; h < 24; h++) {
      const segments = hourMap[h] || [];
      if (segments.length === 0) continue;

      const clearingPrice = priceMap[h] || 0;
      const avgPrice = avg7DayPrice[h] || 0;

      const totalCap = segments.reduce((s, seg) => s + seg.capacity, 0);
      const weightedAvgPrice = segments.reduce((s, seg) => s + seg.price * seg.capacity, 0) / totalCap;

      if (avgPrice > 0 && weightedAvgPrice > avgPrice * 1.5) {
        anomalies.push({
          trading_day_id: tradingDayId,
          trade_date: td.trade_date,
          hour: h,
          participant_id: gen.id,
          anomaly_type: 'price_inflation',
          metric_values: JSON.stringify({
            weighted_avg_price: weightedAvgPrice,
            avg_7day_price: avgPrice,
            ratio: weightedAvgPrice / avgPrice,
            threshold: 1.5
          }),
          basis: `加权平均报价${weightedAvgPrice.toFixed(2)}元超过近7个交易日同时段平均出清价${avgPrice.toFixed(2)}元的150%(比值${(weightedAvgPrice / avgPrice).toFixed(2)})`
        });
      }

      if (totalCap < gen.installed_capacity * 0.3 && clearingPrice > 0 && weightedAvgPrice > clearingPrice * 1.3) {
        anomalies.push({
          trading_day_id: tradingDayId,
          trade_date: td.trade_date,
          hour: h,
          participant_id: gen.id,
          anomaly_type: 'volume_price_manipulation',
          metric_values: JSON.stringify({
            bid_capacity: totalCap,
            installed_capacity: gen.installed_capacity,
            capacity_ratio: totalCap / gen.installed_capacity,
            weighted_avg_price: weightedAvgPrice,
            clearing_price: clearingPrice,
            price_ratio: weightedAvgPrice / clearingPrice,
            capacity_threshold: 0.3,
            price_threshold: 1.3
          }),
          basis: `报价容量${totalCap.toFixed(2)}MW不足装机容量${gen.installed_capacity}MW的30%(比值${(totalCap / gen.installed_capacity).toFixed(2)})，且加权单价${weightedAvgPrice.toFixed(2)}元超过出清价${clearingPrice.toFixed(2)}元的130%(比值${(weightedAvgPrice / clearingPrice).toFixed(2)})`
        });
      }
    }
  }

  for (let h = 0; h < 24; h++) {
    const allBids = db.prepare(`
      SELECT g.participant_id, g.segment_index, g.price, g.capacity, p.name, p.code
      FROM generator_bids g
      JOIN market_participants p ON g.participant_id = p.id
      WHERE g.trading_day_id = ? AND g.hour = ?
      ORDER BY g.participant_id, g.segment_index
    `).all(tradingDayId, h);

    const grouped = {};
    for (const bid of allBids) {
      if (!grouped[bid.participant_id]) {
        grouped[bid.participant_id] = { participant_id: bid.participant_id, name: bid.name, code: bid.code, segments: [] };
      }
      grouped[bid.participant_id].segments.push({ segment_index: bid.segment_index, price: bid.price, capacity: bid.capacity });
    }

    const participants = Object.values(grouped);
    if (participants.length < 2) continue;

    const parent = {};
    const rank = {};
    for (const p of participants) {
      parent[p.participant_id] = p.participant_id;
      rank[p.participant_id] = 0;
    }

    function find(x) {
      if (parent[x] !== x) parent[x] = find(parent[x]);
      return parent[x];
    }

    function union(a, b) {
      const ra = find(a);
      const rb = find(b);
      if (ra === rb) return;
      if (rank[ra] < rank[rb]) { parent[ra] = rb; }
      else if (rank[ra] > rank[rb]) { parent[rb] = ra; }
      else { parent[rb] = ra; rank[ra]++; }
    }

    function areCurvesSimilar(a, b) {
      if (a.segments.length !== b.segments.length) return false;
      for (let i = 0; i < a.segments.length; i++) {
        const pA = a.segments[i].price;
        const pB = b.segments[i].price;
        if (pA === 0 && pB === 0) continue;
        const maxP = Math.max(pA, pB);
        if (maxP === 0) continue;
        if (Math.abs(pA - pB) / maxP > 0.05) return false;
      }
      return true;
    }

    for (let i = 0; i < participants.length; i++) {
      for (let j = i + 1; j < participants.length; j++) {
        if (areCurvesSimilar(participants[i], participants[j])) {
          union(participants[i].participant_id, participants[j].participant_id);
        }
      }
    }

    const clusters = {};
    for (const p of participants) {
      const root = find(p.participant_id);
      if (!clusters[root]) clusters[root] = [];
      clusters[root].push(p);
    }

    for (const cluster of Object.values(clusters)) {
      if (cluster.length < 2) continue;

      const participantsInfo = cluster.map(p => ({
        participant_id: p.participant_id,
        name: p.name,
        code: p.code,
        segments: p.segments
      }));

      anomalies.push({
        trading_day_id: tradingDayId,
        trade_date: td.trade_date,
        hour: h,
        participant_id: null,
        anomaly_type: 'collusion_suspected',
        metric_values: JSON.stringify({
          participants: participantsInfo,
          segment_count: cluster[0].segments.length,
          price_deviation_threshold: 0.05
        }),
        basis: `同时段内${cluster.length}家电厂报价曲线结构高度相似(段数均为${cluster[0].segments.length}段，各段价格偏差在5%以内)，涉及主体：${cluster.map(p => p.name).join('、')}`
      });
    }
  }

  const tx = db.transaction(() => {
    db.prepare(`
      DELETE FROM supervision_anomalies WHERE trading_day_id = ?
    `).run(tradingDayId);

    const insertStmt = db.prepare(`
      INSERT INTO supervision_anomalies (id, trading_day_id, trade_date, hour, participant_id, anomaly_type, metric_values, basis)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const a of anomalies) {
      insertStmt.run(uuidv4(), a.trading_day_id, a.trade_date, a.hour, a.participant_id, a.anomaly_type, a.metric_values, a.basis);
    }
  });

  tx();

  return { trading_day_id: tradingDayId, trade_date: td.trade_date, anomaly_count: anomalies.length, anomalies };
}

function calculateHHI(tradingDayId) {
  const td = getTradingDayById(tradingDayId);
  if (!td) throw new Error('交易日不存在');
  if (td.status === 'bidding') throw new Error('该交易日尚未出清');

  const clearingResults = db.prepare(`
    SELECT cr.hour, cr.clearing_price, cr.clearing_volume,
           ca.participant_id, ca.final_dispatch, p.name, p.code, p.type
    FROM clearing_results cr
    JOIN clearing_allocations ca ON cr.id = ca.clearing_result_id
    JOIN market_participants p ON ca.participant_id = p.id
    WHERE cr.trading_day_id = ? AND p.type = 'generator'
    ORDER BY cr.hour
  `).all(tradingDayId);

  const hourlyData = {};
  for (const row of clearingResults) {
    if (!hourlyData[row.hour]) {
      hourlyData[row.hour] = { total_volume: 0, generators: [] };
    }
    hourlyData[row.hour].generators.push({
      participant_id: row.participant_id,
      name: row.name,
      code: row.code,
      final_dispatch: row.final_dispatch
    });
    hourlyData[row.hour].total_volume += row.final_dispatch;
  }

  const hhiRecords = [];

  for (let h = 0; h < 24; h++) {
    const data = hourlyData[h] || { total_volume: 0, generators: [] };
    let hhiValue = 0;
    const shares = [];

    for (const gen of data.generators) {
      const share = data.total_volume > 0 ? gen.final_dispatch / data.total_volume : 0;
      hhiValue += share * share;
      shares.push({
        participant_id: gen.participant_id,
        name: gen.name,
        code: gen.code,
        dispatched: gen.final_dispatch,
        share: share
      });
    }

    hhiValue = Math.round(hhiValue * 10000 * 100) / 100;

    let concentrationLevel = 'low';
    if (hhiValue > 2500) concentrationLevel = 'high';
    else if (hhiValue >= 1800) concentrationLevel = 'moderate';

    hhiRecords.push({
      trading_day_id: tradingDayId,
      trade_date: td.trade_date,
      hour: h,
      hhi_value: hhiValue,
      concentration_level: concentrationLevel,
      share_details: JSON.stringify(shares)
    });
  }

  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM supervision_hhi_records WHERE trading_day_id = ?`).run(tradingDayId);

    const insertStmt = db.prepare(`
      INSERT INTO supervision_hhi_records (id, trading_day_id, trade_date, hour, hhi_value, concentration_level, share_details)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const r of hhiRecords) {
      insertStmt.run(uuidv4(), r.trading_day_id, r.trade_date, r.hour, r.hhi_value, r.concentration_level, r.share_details);
    }
  });

  tx();

  return { trading_day_id: tradingDayId, trade_date: td.trade_date, hhi_records: hhiRecords };
}

function checkMarketDominance(tradingDayId) {
  const td = getTradingDayById(tradingDayId);
  if (!td) throw new Error('交易日不存在');

  const recent3Days = db.prepare(`
    SELECT id, trade_date FROM trading_days
    WHERE trade_date <= ? AND status != 'bidding'
    ORDER BY trade_date DESC LIMIT 3
  `).all(td.trade_date);

  if (recent3Days.length < 3) return { alerts: [], message: '不足3个已出清交易日，无法判断市场支配地位' };

  const generators = listParticipants('generator');
  const alerts = [];

  for (const gen of generators) {
    for (let h = 0; h < 24; h++) {
      let consecutiveDays = 0;
      let dominant = true;

      for (const day of recent3Days) {
        const totalRow = db.prepare(`
          SELECT SUM(ca.final_dispatch) as total_dispatch
          FROM clearing_results cr
          JOIN clearing_allocations ca ON cr.id = ca.clearing_result_id
          JOIN market_participants p ON ca.participant_id = p.id
          WHERE cr.trading_day_id = ? AND cr.hour = ? AND p.type = 'generator'
        `).get(day.id, h);

        const genRow = db.prepare(`
          SELECT ca.final_dispatch
          FROM clearing_results cr
          JOIN clearing_allocations ca ON cr.id = ca.clearing_result_id
          WHERE cr.trading_day_id = ? AND cr.hour = ? AND ca.participant_id = ?
        `).get(day.id, h, gen.id);

        const totalDispatch = totalRow?.total_dispatch || 0;
        const genDispatch = genRow?.final_dispatch || 0;

        if (totalDispatch > 0 && genDispatch / totalDispatch > 0.4) {
          consecutiveDays++;
        } else {
          dominant = false;
          break;
        }
      }

      if (dominant && consecutiveDays >= 3) {
        const shares = [];
        for (const day of recent3Days) {
          const totalRow = db.prepare(`
            SELECT SUM(ca.final_dispatch) as total_dispatch
            FROM clearing_results cr
            JOIN clearing_allocations ca ON cr.id = ca.clearing_result_id
            JOIN market_participants p ON ca.participant_id = p.id
            WHERE cr.trading_day_id = ? AND cr.hour = ? AND p.type = 'generator'
          `).get(day.id, h);

          const genRow = db.prepare(`
            SELECT ca.final_dispatch
            FROM clearing_results cr
            JOIN clearing_allocations ca ON cr.id = ca.clearing_result_id
            WHERE cr.trading_day_id = ? AND cr.hour = ? AND ca.participant_id = ?
          `).get(day.id, h, gen.id);

          const totalDispatch = totalRow?.total_dispatch || 0;
          const genDispatch = genRow?.final_dispatch || 0;
          shares.push({
            trade_date: day.trade_date,
            share: totalDispatch > 0 ? genDispatch / totalDispatch : 0,
            dispatched: genDispatch,
            total_dispatched: totalDispatch
          });
        }

        alerts.push({
          trading_day_id: tradingDayId,
          trade_date: td.trade_date,
          hour: h,
          alert_type: 'market_dominance',
          participant_id: gen.id,
          metric_values: JSON.stringify({
            participant_name: gen.name,
            participant_code: gen.code,
            consecutive_days: 3,
            shares: shares
          })
        });
      }
    }
  }

  const tx = db.transaction(() => {
    const insertStmt = db.prepare(`
      INSERT INTO supervision_alerts (id, trading_day_id, trade_date, hour, alert_type, participant_id, metric_values)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const a of alerts) {
      insertStmt.run(uuidv4(), a.trading_day_id, a.trade_date, a.hour, a.alert_type, a.participant_id, a.metric_values);
    }
  });

  tx();

  return { trading_day_id: tradingDayId, trade_date: td.trade_date, dominance_alerts: alerts };
}

function checkPriceFluctuation(tradingDayId) {
  const td = getTradingDayById(tradingDayId);
  if (!td) throw new Error('交易日不存在');
  if (td.status === 'bidding') throw new Error('该交易日尚未出清');

  const currentPrices = db.prepare(`
    SELECT hour, clearing_price FROM clearing_results WHERE trading_day_id = ? ORDER BY hour
  `).all(tradingDayId);

  const alerts = [];

  const previousDay = db.prepare(`
    SELECT id, trade_date FROM trading_days
    WHERE trade_date < ? AND status != 'bidding'
    ORDER BY trade_date DESC LIMIT 1
  `).get(td.trade_date);

  if (previousDay) {
    const prevPrices = db.prepare(`
      SELECT hour, clearing_price FROM clearing_results WHERE trading_day_id = ? ORDER BY hour
    `).all(previousDay.id);

    const prevPriceMap = {};
    for (const pp of prevPrices) prevPriceMap[pp.hour] = pp.clearing_price;

    for (const cp of currentPrices) {
      const prevPrice = prevPriceMap[cp.hour];
      if (!prevPrice || prevPrice === 0) continue;

      const changeRatio = (cp.clearing_price - prevPrice) / prevPrice;

      if (changeRatio > 0.5) {
        alerts.push({
          trading_day_id: tradingDayId,
          trade_date: td.trade_date,
          hour: cp.hour,
          alert_type: 'price_spike',
          participant_id: null,
          metric_values: JSON.stringify({
            current_price: cp.clearing_price,
            previous_price: prevPrice,
            previous_trade_date: previousDay.trade_date,
            change_ratio: changeRatio,
            threshold: 0.5
          })
        });
      } else if (changeRatio < -0.3) {
        alerts.push({
          trading_day_id: tradingDayId,
          trade_date: td.trade_date,
          hour: cp.hour,
          alert_type: 'price_drop',
          participant_id: null,
          metric_values: JSON.stringify({
            current_price: cp.clearing_price,
            previous_price: prevPrice,
            previous_trade_date: previousDay.trade_date,
            change_ratio: changeRatio,
            threshold: -0.3
          })
        });
      }
    }
  }

  const previous7Days = db.prepare(`
    SELECT td.id, td.trade_date FROM trading_days td
    WHERE td.trade_date < ? AND td.status != 'bidding'
    ORDER BY td.trade_date DESC LIMIT 7
  `).all(td.trade_date);

  if (previous7Days.length > 0) {
    let currentDayAvg = 0;
    let currentCount = 0;
    for (const cp of currentPrices) {
      currentDayAvg += cp.clearing_price;
      currentCount++;
    }
    currentDayAvg = currentCount > 0 ? currentDayAvg / currentCount : 0;

    let sevenDayTotal = 0;
    let sevenDayCount = 0;
    for (const ptd of previous7Days) {
      const dayPrices = db.prepare(`
        SELECT AVG(clearing_price) as avg_price FROM clearing_results WHERE trading_day_id = ?
      `).get(ptd.id);
      if (dayPrices && dayPrices.avg_price) {
        sevenDayTotal += dayPrices.avg_price;
        sevenDayCount++;
      }
    }

    const sevenDayAvg = sevenDayCount > 0 ? sevenDayTotal / sevenDayCount : 0;

    if (sevenDayAvg > 0 && currentDayAvg > 0) {
      const deviation = Math.abs(currentDayAvg - sevenDayAvg) / sevenDayAvg;
      if (deviation > 0.4) {
        alerts.push({
          trading_day_id: tradingDayId,
          trade_date: td.trade_date,
          hour: null,
          alert_type: 'daily_price_anomaly',
          participant_id: null,
          metric_values: JSON.stringify({
            daily_avg_price: currentDayAvg,
            seven_day_avg_price: sevenDayAvg,
            deviation_ratio: deviation,
            direction: currentDayAvg > sevenDayAvg ? 'above' : 'below',
            threshold: 0.4
          })
        });
      }
    }
  }

  const tx = db.transaction(() => {
    db.prepare(`
      DELETE FROM supervision_alerts WHERE trading_day_id = ? AND alert_type IN ('price_spike', 'price_drop', 'daily_price_anomaly')
    `).run(tradingDayId);

    const insertStmt = db.prepare(`
      INSERT INTO supervision_alerts (id, trading_day_id, trade_date, hour, alert_type, participant_id, metric_values)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const a of alerts) {
      insertStmt.run(uuidv4(), a.trading_day_id, a.trade_date, a.hour, a.alert_type, a.participant_id, a.metric_values);
    }
  });

  tx();

  return { trading_day_id: tradingDayId, trade_date: td.trade_date, price_alerts: alerts };
}

function runFullAnalysis(tradingDayId) {
  const td = getTradingDayById(tradingDayId);
  if (!td) throw new Error('交易日不存在');
  if (td.status === 'bidding') throw new Error('该交易日尚未出清');

  const biddingResult = analyzeBiddingBehavior(tradingDayId);
  const hhiResult = calculateHHI(tradingDayId);
  const priceResult = checkPriceFluctuation(tradingDayId);
  const dominanceResult = checkMarketDominance(tradingDayId);

  return {
    trading_day_id: tradingDayId,
    trade_date: td.trade_date,
    bidding_analysis: {
      anomaly_count: biddingResult.anomaly_count,
      anomalies: biddingResult.anomalies
    },
    hhi_analysis: {
      hhi_records: hhiResult.hhi_records
    },
    price_alerts: {
      alerts: priceResult.price_alerts
    },
    dominance_alerts: {
      alerts: dominanceResult.dominance_alerts
    }
  };
}

function getHHIByTradingDay(tradeDate) {
  const td = db.prepare('SELECT * FROM trading_days WHERE trade_date = ?').get(tradeDate);
  if (!td) throw new Error('交易日不存在');

  const records = db.prepare(`
    SELECT hour, hhi_value, concentration_level, share_details
    FROM supervision_hhi_records
    WHERE trading_day_id = ?
    ORDER BY hour
  `).all(td.id);

  if (records.length === 0) {
    return calculateHHI(td.id);
  }

  const hhiSequence = [];
  for (let h = 0; h < 24; h++) {
    const record = records.find(r => r.hour === h);
    hhiSequence.push(record ? {
      hour: h,
      hhi_value: record.hhi_value,
      concentration_level: record.concentration_level,
      share_details: record.share_details ? JSON.parse(record.share_details) : []
    } : { hour: h, hhi_value: 0, concentration_level: 'low', share_details: [] });
  }

  return {
    trade_date: tradeDate,
    hhi_sequence: hhiSequence
  };
}

function getAnomalies(filters = {}) {
  let sql = `
    SELECT sa.*, p.name as participant_name, p.code as participant_code, p.type as participant_type
    FROM supervision_anomalies sa
    LEFT JOIN market_participants p ON sa.participant_id = p.id
    WHERE 1=1
  `;
  const params = [];

  if (filters.trade_date) {
    sql += ' AND sa.trade_date = ?';
    params.push(filters.trade_date);
  }
  if (filters.start_date) {
    sql += ' AND sa.trade_date >= ?';
    params.push(filters.start_date);
  }
  if (filters.end_date) {
    sql += ' AND sa.trade_date <= ?';
    params.push(filters.end_date);
  }
  if (filters.hour != null) {
    sql += ' AND sa.hour = ?';
    params.push(filters.hour);
  }
  if (filters.participant_id) {
    sql += ' AND sa.participant_id = ?';
    params.push(filters.participant_id);
  }
  if (filters.anomaly_type) {
    sql += ' AND sa.anomaly_type = ?';
    params.push(filters.anomaly_type);
  }

  sql += ' ORDER BY sa.trade_date DESC, sa.hour ASC, sa.anomaly_type';

  const rows = db.prepare(sql).all(...params);

  return rows.map(row => ({
    id: row.id,
    trading_day_id: row.trading_day_id,
    trade_date: row.trade_date,
    hour: row.hour,
    participant_id: row.participant_id,
    participant_name: row.participant_name,
    participant_code: row.participant_code,
    anomaly_type: row.anomaly_type,
    metric_values: row.metric_values ? JSON.parse(row.metric_values) : {},
    basis: row.basis,
    created_at: row.created_at
  }));
}

function getAlerts(filters = {}) {
  let sql = `
    SELECT sal.*, p.name as participant_name, p.code as participant_code
    FROM supervision_alerts sal
    LEFT JOIN market_participants p ON sal.participant_id = p.id
    WHERE 1=1
  `;
  const params = [];

  if (filters.trade_date) {
    sql += ' AND sal.trade_date = ?';
    params.push(filters.trade_date);
  }
  if (filters.start_date) {
    sql += ' AND sal.trade_date >= ?';
    params.push(filters.start_date);
  }
  if (filters.end_date) {
    sql += ' AND sal.trade_date <= ?';
    params.push(filters.end_date);
  }
  if (filters.alert_type) {
    sql += ' AND sal.alert_type = ?';
    params.push(filters.alert_type);
  }
  if (filters.participant_id) {
    sql += ' AND sal.participant_id = ?';
    params.push(filters.participant_id);
  }

  sql += ' ORDER BY sal.trade_date DESC, sal.hour ASC';

  const rows = db.prepare(sql).all(...params);

  return rows.map(row => ({
    id: row.id,
    trading_day_id: row.trading_day_id,
    trade_date: row.trade_date,
    hour: row.hour,
    alert_type: row.alert_type,
    participant_id: row.participant_id,
    participant_name: row.participant_name,
    participant_code: row.participant_code,
    metric_values: row.metric_values ? JSON.parse(row.metric_values) : {},
    created_at: row.created_at
  }));
}

function generateRegulatoryReport(startDate, endDate, participantId = null) {
  if (!startDate || !endDate) throw new Error('起止日期为必填项');

  let anomalyFilter = { start_date: startDate, end_date: endDate };
  let alertFilter = { start_date: startDate, end_date: endDate };

  if (participantId) {
    anomalyFilter.participant_id = participantId;
    alertFilter.participant_id = participantId;
  }

  const anomalies = getAnomalies(anomalyFilter);
  const alerts = getAlerts(alertFilter);

  const typeStats = {
    price_inflation: { count: 0, label: '疑似抬价' },
    volume_price_manipulation: { count: 0, label: '量价操纵' },
    collusion_suspected: { count: 0, label: '疑似串谋' }
  };

  for (const a of anomalies) {
    if (typeStats[a.anomaly_type]) {
      typeStats[a.anomaly_type].count++;
    }
  }

  const participantFlagCount = {};
  for (const a of anomalies) {
    if (a.participant_id) {
      if (!participantFlagCount[a.participant_id]) {
        participantFlagCount[a.participant_id] = {
          participant_id: a.participant_id,
          participant_name: a.participant_name,
          participant_code: a.participant_code,
          count: 0,
          anomalies: []
        };
      }
      participantFlagCount[a.participant_id].count++;
      participantFlagCount[a.participant_id].anomalies.push(a);
    } else if (a.anomaly_type === 'collusion_suspected') {
      const metrics = a.metric_values;
      if (metrics.participants) {
        for (const p of metrics.participants) {
          if (!participantFlagCount[p.participant_id]) {
            participantFlagCount[p.participant_id] = {
              participant_id: p.participant_id,
              participant_name: p.name,
              participant_code: p.code,
              count: 0,
              anomalies: []
            };
          }
          participantFlagCount[p.participant_id].count++;
          participantFlagCount[p.participant_id].anomalies.push(a);
        }
      }
    }
  }

  const top5Participants = Object.values(participantFlagCount)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  const tradingDays = db.prepare(`
    SELECT DISTINCT trade_date FROM trading_days
    WHERE trade_date >= ? AND trade_date <= ? AND status != 'bidding'
    ORDER BY trade_date
  `).all(startDate, endDate);

  const hhiTrend = [];
  for (const td of tradingDays) {
    const dayHHI = db.prepare(`
      SELECT AVG(hhi_value) as avg_hhi FROM supervision_hhi_records WHERE trade_date = ?
    `).get(td.trade_date);
    hhiTrend.push({
      trade_date: td.trade_date,
      avg_hhi: dayHHI?.avg_hhi || 0
    });
  }

  const priceAlertStats = {
    price_spike: { count: 0, label: '价格异常上涨' },
    price_drop: { count: 0, label: '价格异常下跌' },
    daily_price_anomaly: { count: 0, label: '日均价异常' },
    market_dominance: { count: 0, label: '市场支配地位预警' }
  };

  for (const a of alerts) {
    if (priceAlertStats[a.alert_type]) {
      priceAlertStats[a.alert_type].count++;
    }
  }

  return {
    report_period: { start_date: startDate, end_date: endDate },
    participant_filter: participantId || null,
    anomaly_summary: typeStats,
    top_flagged_participants: top5Participants,
    hhi_trend: hhiTrend,
    price_alert_summary: priceAlertStats,
    total_anomalies: anomalies.length,
    total_alerts: alerts.length
  };
}

function getParticipantAnomalyHistory(participantId) {
  const p = getParticipantById(participantId);
  if (!p) throw new Error('市场主体不存在');

  const directAnomalies = getAnomalies({ participant_id: participantId });

  const collusionAnomalies = db.prepare(`
    SELECT sa.*, p.name as participant_name, p.code as participant_code
    FROM supervision_anomalies sa
    LEFT JOIN market_participants p ON sa.participant_id = p.id
    WHERE sa.anomaly_type = 'collusion_suspected' AND sa.metric_values LIKE ?
    ORDER BY sa.trade_date DESC, sa.hour ASC
  `).all(`%"participant_id":"${participantId}"%`);

  const allAnomalies = [...directAnomalies];
  const existingIds = new Set(directAnomalies.map(a => a.id));
  for (const ca of collusionAnomalies) {
    if (!existingIds.has(ca.id)) {
      allAnomalies.push({
        ...ca,
        metric_values: ca.metric_values ? JSON.parse(ca.metric_values) : {}
      });
    }
  }

  allAnomalies.sort((a, b) => b.trade_date.localeCompare(a.trade_date) || a.hour - b.hour);

  const typeCounts = {
    price_inflation: 0,
    volume_price_manipulation: 0,
    collusion_suspected: 0
  };

  for (const a of allAnomalies) {
    if (typeCounts[a.anomaly_type] !== undefined) {
      typeCounts[a.anomaly_type]++;
    }
  }

  const penaltySuggestions = [];
  if (typeCounts.price_inflation >= 3) {
    penaltySuggestions.push({
      type: 'warning',
      reason: `抬价行为${typeCounts.price_inflation}次，达到3次以上阈值`,
      suggestion: '建议发出警告'
    });
  }
  if (typeCounts.volume_price_manipulation >= 2) {
    penaltySuggestions.push({
      type: 'fine',
      reason: `量价操纵行为${typeCounts.volume_price_manipulation}次，达到2次以上阈值`,
      suggestion: '建议处以罚款'
    });
  }
  if (typeCounts.collusion_suspected >= 1) {
    penaltySuggestions.push({
      type: 'investigation',
      reason: `涉嫌串谋${typeCounts.collusion_suspected}次`,
      suggestion: '建议立案调查'
    });
  }

  return {
    participant: {
      id: p.id,
      code: p.code,
      name: p.name,
      type: p.type,
      installed_capacity: p.installed_capacity
    },
    type_counts: typeCounts,
    total_anomalies: allAnomalies.length,
    anomalies: allAnomalies,
    penalty_suggestions: penaltySuggestions
  };
}

module.exports = {
  analyzeBiddingBehavior,
  calculateHHI,
  checkMarketDominance,
  checkPriceFluctuation,
  runFullAnalysis,
  getHHIByTradingDay,
  getAnomalies,
  getAlerts,
  generateRegulatoryReport,
  getParticipantAnomalyHistory
};
