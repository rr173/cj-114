const { v4: uuidv4 } = require('uuid');
const db = require('../utils/db');
const { getTradingDayById, getTradingDayByDate } = require('./tradingDayService');
const { listParticipants, getParticipantById } = require('./participantService');
const { decomposeContractsForDate, getDecompositionByDate } = require('./contractService');

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

  decomposeContractsForDate(td.trade_date);

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

  const decomposition = getDecompositionByDate(td.trade_date);

  const contractMap = {};
  for (const d of decomposition) {
    if (!contractMap[d.buyer_id]) contractMap[d.buyer_id] = {};
    if (!contractMap[d.seller_id]) contractMap[d.seller_id] = {};
    if (!contractMap[d.buyer_id][d.hour]) contractMap[d.buyer_id][d.hour] = [];
    if (!contractMap[d.seller_id][d.hour]) contractMap[d.seller_id][d.hour] = [];
    contractMap[d.buyer_id][d.hour].push({ ...d, side: 'buyer' });
    contractMap[d.seller_id][d.hour].push({ ...d, side: 'seller' });
  }

  const contractPriceMap = {};
  const contracts = db.prepare('SELECT id, contract_price FROM mid_long_term_contracts').all();
  for (const c of contracts) contractPriceMap[c.id] = c.contract_price;

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM settlement_details WHERE trading_day_id = ?').run(tradingDayId);

    const insertStmt = db.prepare(`
      INSERT INTO settlement_details
      (id, trading_day_id, participant_id, hour, item_type, contract_id,
       volume, direction, unit_price, amount)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const spotAllocMap = {};
    for (const alloc of allocations) {
      if (!spotAllocMap[alloc.participant_id]) spotAllocMap[alloc.participant_id] = {};
      spotAllocMap[alloc.participant_id][alloc.hour] = alloc;
    }

    const allPartIds = new Set();
    for (const a of allocations) allPartIds.add(a.participant_id);
    for (const d of decomposition) {
      allPartIds.add(d.buyer_id);
      allPartIds.add(d.seller_id);
    }

    for (const partId of allPartIds) {
      const participant = getParticipantById(partId);
      if (!participant) continue;

      for (let h = 0; h < 24; h++) {
        const spotAlloc = spotAllocMap[partId]?.[h];
        const spotVolume = spotAlloc?.final_dispatch || 0;
        const clearingPrice = spotAlloc?.clearing_price || 0;
        const partType = participant.type;

        const contractItems = contractMap[partId]?.[h] || [];
        let totalContractVolume = 0;
        for (const ci of contractItems) {
          totalContractVolume += ci.decomposed_energy;
        }

        const actualVolume = actualMap[partId]?.[h] || 0;
        const totalObligation = spotVolume + totalContractVolume;

        let deviation;
        if (partType === 'generator') {
          deviation = actualVolume - totalObligation;
        } else {
          deviation = totalObligation - actualVolume;
        }

        for (const ci of contractItems) {
          const contractPrice = contractPriceMap[ci.contract_id] || 0;
          let vol, amount;
          if (ci.side === 'buyer') {
            vol = ci.decomposed_energy;
            amount = vol * contractPrice;
          } else {
            vol = ci.decomposed_energy;
            amount = -vol * contractPrice;
          }
          insertStmt.run(
            uuidv4(), tradingDayId, partId, h, 'contract', ci.contract_id,
            vol, ci.side, contractPrice, amount
          );
        }

        if (spotVolume > 0) {
          let spotAmount;
          if (partType === 'generator') {
            spotAmount = -spotVolume * clearingPrice;
          } else {
            spotAmount = spotVolume * clearingPrice;
          }
          insertStmt.run(
            uuidv4(), tradingDayId, partId, h, 'spot', null,
            spotVolume, partType === 'generator' ? 'sell' : 'buy', clearingPrice, spotAmount
          );
        }

        const EPSILON = 0.0001;
        if (Math.abs(deviation) >= EPSILON) {
          let deviationDirection;
          let settlementPrice;

          if (deviation > 0) {
            deviationDirection = 'positive';
            settlementPrice = clearingPrice * POSITIVE_DEVIATION_RATIO;
          } else {
            deviationDirection = 'negative';
            settlementPrice = clearingPrice * NEGATIVE_DEVIATION_RATIO;
          }

          const absDeviation = Math.abs(deviation);
          const settlementAmount = absDeviation * (settlementPrice - clearingPrice);

          insertStmt.run(
            uuidv4(), tradingDayId, partId, h, 'deviation', null,
            absDeviation, deviationDirection, settlementPrice, settlementAmount
          );
        }
      }
    }

    db.prepare('UPDATE trading_days SET status = ? WHERE id = ?').run('settled', tradingDayId);
  });

  tx();

  return getSettlementByTradingDay(tradingDayId);
}

function _buildSettlementResponse(tradingDayId, rows, td) {
  const byParticipant = {};
  let totalAmount = 0;
  let totalContractAmount = 0;
  let totalSpotAmount = 0;
  let totalDeviationAmount = 0;

  for (const row of rows) {
    if (!byParticipant[row.participant_id]) {
      byParticipant[row.participant_id] = {
        participant_id: row.participant_id,
        code: row.code,
        name: row.name,
        type: row.type,
        total_spot_volume: 0,
        total_contract_volume: 0,
        total_actual: 0,
        total_deviation: 0,
        total_contract_amount: 0,
        total_spot_amount: 0,
        total_deviation_amount: 0,
        total_settlement_amount: 0,
        hourly: []
      };
    }

    const p = byParticipant[row.participant_id];
    if (row.item_type === 'spot') p.total_spot_volume += row.volume;
    if (row.item_type === 'contract') p.total_contract_volume += row.volume;
    if (row.item_type === 'deviation') p.total_deviation += row.volume;

    if (row.item_type === 'contract') {
      p.total_contract_amount += row.amount;
      totalContractAmount += row.amount;
    } else if (row.item_type === 'spot') {
      p.total_spot_amount += row.amount;
      totalSpotAmount += row.amount;
    } else if (row.item_type === 'deviation') {
      p.total_deviation_amount += row.amount;
      totalDeviationAmount += row.amount;
    }
    p.total_settlement_amount += row.amount;
    totalAmount += row.amount;
  }

  for (const partId in byParticipant) {
    const p = byParticipant[partId];
    for (let h = 0; h < 24; h++) {
      const hourRows = rows.filter(r => r.participant_id === partId && r.hour === h);
      const contractItems = hourRows.filter(r => r.item_type === 'contract').map(r => ({
        contract_id: r.contract_id,
        volume: r.volume,
        direction: r.direction,
        unit_price: r.unit_price,
        amount: r.amount
      }));
      const spotItem = hourRows.find(r => r.item_type === 'spot');
      const devItem = hourRows.find(r => r.item_type === 'deviation');

      p.hourly.push({
        hour: h,
        contract: contractItems,
        spot: spotItem ? {
          volume: spotItem.volume,
          direction: spotItem.direction,
          unit_price: spotItem.unit_price,
          amount: spotItem.amount
        } : null,
        deviation: devItem ? {
          volume: devItem.volume,
          direction: devItem.direction,
          unit_price: devItem.unit_price,
          amount: devItem.amount
        } : null
      });
    }

    const actualList = db.prepare(`
      SELECT hour, actual_volume FROM actual_volumes
      WHERE trading_day_id = ? AND participant_id = ?
    `).all(tradingDayId, partId);
    for (const a of actualList) p.total_actual += a.actual_volume;
  }

  return {
    trading_day_id: tradingDayId,
    trade_date: td.trade_date,
    status: td.status,
    summary: {
      total_contract_amount: totalContractAmount,
      total_spot_amount: totalSpotAmount,
      total_deviation_amount: totalDeviationAmount,
      total_settlement_amount: totalAmount
    },
    participants: Object.values(byParticipant)
  };
}

function getSettlementByTradingDay(tradingDayId) {
  const td = getTradingDayById(tradingDayId);
  if (!td) throw new Error('交易日不存在');

  const rows = db.prepare(`
    SELECT s.*, p.code, p.name, p.type
    FROM settlement_details s
    JOIN market_participants p ON s.participant_id = p.id
    WHERE s.trading_day_id = ?
    ORDER BY s.hour, p.type, p.code, s.item_type
  `).all(tradingDayId);

  return _buildSettlementResponse(tradingDayId, rows, td);
}

function getSettlementByParticipant(tradingDayId, participantId) {
  const td = getTradingDayById(tradingDayId);
  if (!td) throw new Error('交易日不存在');
  const p = getParticipantById(participantId);
  if (!p) throw new Error('市场主体不存在');

  const rows = db.prepare(`
    SELECT s.*, part.code, part.name, part.type
    FROM settlement_details s
    JOIN market_participants part ON s.participant_id = part.id
    WHERE s.trading_day_id = ? AND s.participant_id = ?
    ORDER BY s.hour, s.item_type
  `).all(tradingDayId, participantId);

  const resp = _buildSettlementResponse(tradingDayId, rows, td);
  return {
    participant: p,
    trade_date: td.trade_date,
    status: td.status,
    data: resp.participants[0] || null
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

  const decomposition = getDecompositionByDate(td.trade_date);
  const contractRows = decomposition.filter(
    d => d.buyer_id === participantId || d.seller_id === participantId
  );

  const settlementRows = db.prepare(`
    SELECT hour, item_type, contract_id, volume, direction, unit_price, amount
    FROM settlement_details
    WHERE trading_day_id = ? AND participant_id = ?
    ORDER BY hour, item_type
  `).all(tradingDayId, participantId);

  const hourlyMap = {};
  for (let h = 0; h < 24; h++) hourlyMap[h] = {
    hour: h,
    contract_volume: 0,
    contract_items: []
  };

  for (const r of clearingRows) {
    hourlyMap[r.hour] = {
      ...hourlyMap[r.hour],
      clearing_price: r.clearing_price,
      initial_allocation: r.initial_allocation,
      adjusted_allocation: r.adjusted_allocation,
      final_dispatch: r.final_dispatch,
      adjustment_reason: r.adjustment_reason
    };
  }
  for (const r of actualRows) {
    hourlyMap[r.hour].actual_volume = r.actual_volume;
  }
  for (const c of contractRows) {
    const side = c.buyer_id === participantId ? 'buyer' : 'seller';
    hourlyMap[c.hour].contract_volume += c.decomposed_energy;
    hourlyMap[c.hour].contract_items.push({
      contract_id: c.contract_id,
      contract_no: c.contract_no,
      counterparty: side === 'buyer'
        ? { id: c.seller_id, code: c.seller_code, name: c.seller_name }
        : { id: c.buyer_id, code: c.buyer_code, name: c.buyer_name },
      side: side,
      decomposed_energy: c.decomposed_energy
    });
  }

  for (const s of settlementRows) {
    if (!hourlyMap[s.hour].settlement_items) hourlyMap[s.hour].settlement_items = [];
    hourlyMap[s.hour].settlement_items.push({
      item_type: s.item_type,
      contract_id: s.contract_id,
      volume: s.volume,
      direction: s.direction,
      unit_price: s.unit_price,
      amount: s.amount
    });
  }

  const hourly = [];
  let totalSpot = 0, totalActual = 0, totalContract = 0;
  let totalContractAmt = 0, totalSpotAmt = 0, totalDevAmt = 0;
  for (let h = 0; h < 24; h++) {
    const item = hourlyMap[h];
    hourly.push(item);
    if (item.final_dispatch) totalSpot += item.final_dispatch;
    if (item.actual_volume) totalActual += item.actual_volume;
    if (item.contract_volume) totalContract += item.contract_volume;
    if (item.settlement_items) {
      for (const si of item.settlement_items) {
        if (si.item_type === 'contract') totalContractAmt += si.amount;
        else if (si.item_type === 'spot') totalSpotAmt += si.amount;
        else if (si.item_type === 'deviation') totalDevAmt += si.amount;
      }
    }
  }

  return {
    participant: p,
    trade_date: td.trade_date,
    status: td.status,
    summary: {
      total_spot_volume: totalSpot,
      total_contract_volume: totalContract,
      total_obligation: totalSpot + totalContract,
      total_actual_volume: totalActual,
      total_contract_settlement: totalContractAmt,
      total_spot_settlement: totalSpotAmt,
      total_deviation_settlement: totalDevAmt,
      total_settlement_amount: totalContractAmt + totalSpotAmt + totalDevAmt
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
