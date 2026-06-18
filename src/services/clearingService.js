const { v4: uuidv4 } = require('uuid');
const db = require('../utils/db');
const { getTradingDayById } = require('./tradingDayService');
const { listParticipants, getParticipantById } = require('./participantService');
const { getAllGeneratorBidsByHour, getAllConsumerBidsByHour } = require('./biddingService');

function buildSupplyCurve(bids) {
  const segments = [];
  let cumulativeCapacity = 0;
  const participantTotal = {};

  for (const bid of bids) {
    const pid = bid.participant_id;
    if (!participantTotal[pid]) {
      participantTotal[pid] = 0;
    }
    const remaining = bid.installed_capacity - participantTotal[pid];
    if (remaining <= 0) continue;
    const actualCapacity = Math.min(bid.capacity, remaining);
    if (actualCapacity <= 0) continue;

    cumulativeCapacity += actualCapacity;
    participantTotal[pid] += actualCapacity;
    segments.push({
      participant_id: pid,
      price: bid.price,
      capacity: actualCapacity,
      cumulative_capacity: cumulativeCapacity
    });
  }

  return segments;
}

function buildDemandCurve(bids) {
  const segments = [];
  let cumulativeDemand = 0;

  for (const bid of bids) {
    cumulativeDemand += bid.demand;
    segments.push({
      participant_id: bid.participant_id,
      price: bid.max_price,
      demand: bid.demand,
      cumulative_demand: cumulativeDemand
    });
  }

  return segments;
}

function findClearingPoint(supplyCurve, demandCurve) {
  if (supplyCurve.length === 0 || demandCurve.length === 0) {
    return { clearingPrice: 0, clearingVolume: 0 };
  }

  let i = 0, j = 0;
  let clearingPrice = 0;
  let clearingVolume = 0;

  while (i < supplyCurve.length && j < demandCurve.length) {
    const supplyPrice = supplyCurve[i].price;
    const demandPrice = demandCurve[j].price;
    const supplyQty = supplyCurve[i].cumulative_capacity;
    const demandQty = demandCurve[j].cumulative_demand;

    if (supplyPrice <= demandPrice) {
      clearingPrice = supplyPrice;
      clearingVolume = Math.min(supplyQty, demandQty);
      if (supplyQty <= demandQty) {
        i++;
      } else {
        j++;
      }
    } else {
      break;
    }
  }

  if (clearingVolume === 0) {
    return { clearingPrice: 0, clearingVolume: 0 };
  }

  if (i < supplyCurve.length && j > 0) {
    const lastDemand = demandCurve[j - 1];
    const prevSupply = i > 0 ? supplyCurve[i - 1] : null;
    if (prevSupply && lastDemand.cumulative_demand < supplyCurve[i].cumulative_capacity) {
      clearingPrice = lastDemand.price;
      clearingVolume = lastDemand.cumulative_demand;
    }
  }

  if (i >= supplyCurve.length && j < demandCurve.length && demandCurve[j].price >= supplyCurve[i - 1].price) {
    clearingPrice = supplyCurve[i - 1].price;
    clearingVolume = supplyCurve[i - 1].cumulative_capacity;
  }

  if (j >= demandCurve.length && i < supplyCurve.length && supplyCurve[i].price <= demandCurve[j - 1].price) {
    clearingPrice = demandCurve[j - 1].price;
    clearingVolume = demandCurve[j - 1].cumulative_demand;
  }

  return { clearingPrice, clearingVolume };
}

function calculateGeneratorAllocations(supplyCurve, clearingPrice, clearingVolume) {
  const allocations = {};
  let allocated = 0;

  for (const seg of supplyCurve) {
    if (seg.price > clearingPrice || allocated >= clearingVolume) {
      break;
    }
    const remain = clearingVolume - allocated;
    const alloc = Math.min(seg.capacity, remain);
    if (!allocations[seg.participant_id]) {
      allocations[seg.participant_id] = 0;
    }
    allocations[seg.participant_id] += alloc;
    allocated += alloc;
  }

  return allocations;
}

function calculateConsumerAllocations(demandCurve, clearingPrice, clearingVolume) {
  const allocations = {};
  let allocated = 0;

  for (const seg of demandCurve) {
    if (seg.price < clearingPrice || allocated >= clearingVolume) {
      break;
    }
    const remain = clearingVolume - allocated;
    const alloc = Math.min(seg.demand, remain);
    if (!allocations[seg.participant_id]) {
      allocations[seg.participant_id] = 0;
    }
    allocations[seg.participant_id] += alloc;
    allocated += alloc;
  }

  return allocations;
}

function performUnitCommitment(initialAllocations, tradingDayId) {
  const generators = listParticipants('generator');
  const finalAllocations = {};
  const adjustmentReasons = {};

  for (const gen of generators) {
    const pid = gen.id;
    const schedule = [];
    for (let h = 0; h < 24; h++) {
      schedule.push(initialAllocations[h]?.[pid] || 0);
    }

    const adjusted = [...schedule];

    for (let h = 0; h < 24; h++) {
      if (adjusted[h] > 0 && adjusted[h] < gen.min_output) {
        adjusted[h] = gen.min_output;
        adjustmentReasons[`${pid}_${h}`] = (adjustmentReasons[`${pid}_${h}`] || '') +
          `[最小出力调整: ${schedule[h]} → ${gen.min_output}]`;
      }
    }

    for (let h = 1; h < 24; h++) {
      const diff = adjusted[h] - adjusted[h - 1];
      if (diff > gen.ramp_rate) {
        adjusted[h] = adjusted[h - 1] + gen.ramp_rate;
        adjustmentReasons[`${pid}_${h}`] = (adjustmentReasons[`${pid}_${h}`] || '') +
          `[爬坡上调限制]`;
      } else if (diff < -gen.ramp_rate) {
        adjusted[h] = adjusted[h - 1] - gen.ramp_rate;
        adjustmentReasons[`${pid}_${h}`] = (adjustmentReasons[`${pid}_${h}`] || '') +
          `[爬坡下调限制]`;
      }
    }

    for (let h = 0; h < 24; h++) {
      adjusted[h] = Math.min(adjusted[h], gen.installed_capacity);
      if (adjusted[h] < 0) adjusted[h] = 0;
      if (!finalAllocations[h]) finalAllocations[h] = {};
      finalAllocations[h][pid] = {
        initial: schedule[h],
        adjusted: adjusted[h],
        reason: adjustmentReasons[`${pid}_${h}`] || null
      };
    }
  }

  return finalAllocations;
}

function executeClearing(tradingDayId) {
  const td = getTradingDayById(tradingDayId);
  if (!td) {
    throw new Error('交易日不存在');
  }
  if (td.status !== 'bidding') {
    throw new Error('该交易日已完成出清或已结算');
  }

  const consumers = listParticipants('consumer');
  const consumerHourlyBids = {};
  for (let h = 0; h < 24; h++) {
    consumerHourlyBids[h] = getAllConsumerBidsByHour(tradingDayId, h);
  }

  const initialHourlyAllocations = {};
  const clearingResults = [];

  for (let h = 0; h < 24; h++) {
    const genBids = getAllGeneratorBidsByHour(tradingDayId, h);
    const conBids = consumerHourlyBids[h];

    const supplyCurve = buildSupplyCurve(genBids);
    const demandCurve = buildDemandCurve(conBids);
    const { clearingPrice, clearingVolume } = findClearingPoint(supplyCurve, demandCurve);

    const genAllocs = calculateGeneratorAllocations(supplyCurve, clearingPrice, clearingVolume);
    const conAllocs = calculateConsumerAllocations(demandCurve, clearingPrice, clearingVolume);

    initialHourlyAllocations[h] = {
      generators: genAllocs,
      consumers: conAllocs,
      clearingPrice,
      clearingVolume
    };

    clearingResults.push({
      hour: h,
      clearingPrice,
      clearingVolume
    });
  }

  const generatorInitial = {};
  for (let h = 0; h < 24; h++) {
    for (const [pid, vol] of Object.entries(initialHourlyAllocations[h].generators)) {
      if (!generatorInitial[h]) generatorInitial[h] = {};
      generatorInitial[h][pid] = vol;
    }
  }

  const unitCommitmentResult = performUnitCommitment(generatorInitial, tradingDayId);

  const tx = db.transaction(() => {
    db.prepare('UPDATE trading_days SET status = ? WHERE id = ?').run('cleared', tradingDayId);

    const insertClearing = db.prepare(`
      INSERT INTO clearing_results (id, trading_day_id, hour, clearing_price, clearing_volume)
      VALUES (?, ?, ?, ?, ?)
    `);

    const insertAllocation = db.prepare(`
      INSERT INTO clearing_allocations (id, clearing_result_id, participant_id, initial_allocation, adjusted_allocation, final_dispatch, adjustment_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const clearingResultIds = {};
    for (const result of clearingResults) {
      const crId = uuidv4();
      clearingResultIds[result.hour] = crId;
      insertClearing.run(crId, tradingDayId, result.hour, result.clearingPrice, result.clearingVolume);
    }

    for (let h = 0; h < 24; h++) {
      const crId = clearingResultIds[h];

      for (const [pid, allocInfo] of Object.entries(unitCommitmentResult[h] || {})) {
        insertAllocation.run(
          uuidv4(),
          crId,
          pid,
          allocInfo.initial,
          allocInfo.adjusted,
          allocInfo.adjusted,
          allocInfo.reason
        );
      }

      for (const [pid, vol] of Object.entries(initialHourlyAllocations[h].consumers)) {
        insertAllocation.run(
          uuidv4(),
          crId,
          pid,
          vol,
          vol,
          vol,
          null
        );
      }
    }
  });

  tx();

  return getClearingSummary(tradingDayId);
}

function getClearingSummary(tradingDayId) {
  const td = getTradingDayById(tradingDayId);
  if (!td) throw new Error('交易日不存在');

  const results = db.prepare(`
    SELECT cr.id, cr.hour, cr.clearing_price, cr.clearing_volume,
           ca.participant_id, ca.initial_allocation, ca.adjusted_allocation,
           ca.final_dispatch, ca.adjustment_reason,
           p.type, p.name, p.code
    FROM clearing_results cr
    LEFT JOIN clearing_allocations ca ON cr.id = ca.clearing_result_id
    LEFT JOIN market_participants p ON ca.participant_id = p.id
    WHERE cr.trading_day_id = ?
    ORDER BY cr.hour, p.type, p.code
  `).all(tradingDayId);

  const hourly = {};
  for (const row of results) {
    if (!hourly[row.hour]) {
      hourly[row.hour] = {
        hour: row.hour,
        clearing_price: row.clearing_price,
        clearing_volume: row.clearing_volume,
        generators: [],
        consumers: []
      };
    }
    if (row.participant_id) {
      const entry = {
        participant_id: row.participant_id,
        code: row.code,
        name: row.name,
        initial_allocation: row.initial_allocation,
        adjusted_allocation: row.adjusted_allocation,
        final_dispatch: row.final_dispatch,
        adjustment_reason: row.adjustment_reason
      };
      if (row.type === 'generator') {
        hourly[row.hour].generators.push(entry);
      } else {
        hourly[row.hour].consumers.push(entry);
      }
    }
  }

  const hours = [];
  for (let h = 0; h < 24; h++) {
    hours.push(hourly[h] || { hour: h, clearing_price: 0, clearing_volume: 0, generators: [], consumers: [] });
  }

  return {
    trading_day_id: tradingDayId,
    trade_date: td.trade_date,
    status: td.status,
    hourly_results: hours
  };
}

function getParticipantClearing(tradingDayId, participantId) {
  const td = getTradingDayById(tradingDayId);
  if (!td) throw new Error('交易日不存在');
  const p = getParticipantById(participantId);
  if (!p) throw new Error('市场主体不存在');

  const rows = db.prepare(`
    SELECT cr.hour, cr.clearing_price,
           ca.initial_allocation, ca.adjusted_allocation,
           ca.final_dispatch, ca.adjustment_reason
    FROM clearing_results cr
    JOIN clearing_allocations ca ON cr.id = ca.clearing_result_id
    WHERE cr.trading_day_id = ? AND ca.participant_id = ?
    ORDER BY cr.hour
  `).all(tradingDayId, participantId);

  return {
    participant: p,
    trade_date: td.trade_date,
    status: td.status,
    hourly: rows
  };
}

module.exports = {
  executeClearing,
  getClearingSummary,
  getParticipantClearing,
  buildSupplyCurve,
  buildDemandCurve,
  findClearingPoint
};
