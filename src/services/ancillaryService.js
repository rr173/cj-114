const { v4: uuidv4 } = require('uuid');
const db = require('../utils/db');
const { getTradingDayById, isBiddingOpen } = require('./tradingDayService');
const { getParticipantById, listParticipants } = require('./participantService');

function registerAncillaryService(participantId, data) {
  const p = getParticipantById(participantId);
  if (!p) throw new Error('市场主体不存在');
  if (p.type !== 'generator') throw new Error('只有发电侧可以申报辅助服务能力');

  const { services } = data;
  if (!Array.isArray(services) || services.length === 0) {
    throw new Error('辅助服务申报数据不能为空');
  }

  const tx = db.transaction(() => {
    const deleteStmt = db.prepare(
      'DELETE FROM ancillary_service_registrations WHERE participant_id = ? AND service_type = ?'
    );
    const insertStmt = db.prepare(`
      INSERT INTO ancillary_service_registrations
      (id, participant_id, service_type, adjustable_capacity, response_rate, reserve_capacity, startup_time)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const svc of services) {
      if (!['frequency', 'reserve'].includes(svc.service_type)) {
        throw new Error('辅助服务类型必须是 frequency 或 reserve');
      }

      deleteStmt.run(participantId, svc.service_type);

      if (svc.service_type === 'frequency') {
        if (svc.adjustable_capacity == null || svc.adjustable_capacity <= 0) {
          throw new Error('调频服务需声明可调节容量(MW)，且必须大于0');
        }
        if (svc.response_rate == null || svc.response_rate <= 0) {
          throw new Error('调频服务需声明响应速率(MW/s)，且必须大于0');
        }
        if (svc.adjustable_capacity > p.installed_capacity) {
          throw new Error('调频可调节容量不能超过装机容量');
        }
        insertStmt.run(uuidv4(), participantId, 'frequency', svc.adjustable_capacity, svc.response_rate, null, null);
      }

      if (svc.service_type === 'reserve') {
        if (svc.reserve_capacity == null || svc.reserve_capacity <= 0) {
          throw new Error('备用服务需声明备用容量(MW)，且必须大于0');
        }
        if (svc.startup_time == null || svc.startup_time <= 0) {
          throw new Error('备用服务需声明启动时间(分钟)，且必须大于0');
        }
        if (svc.reserve_capacity > p.installed_capacity) {
          throw new Error('备用容量不能超过装机容量');
        }
        insertStmt.run(uuidv4(), participantId, 'reserve', null, null, svc.reserve_capacity, svc.startup_time);
      }
    }
  });

  tx();
  return getAncillaryRegistrations(participantId);
}

function getAncillaryRegistrations(participantId) {
  const rows = db.prepare(`
    SELECT * FROM ancillary_service_registrations
    WHERE participant_id = ?
    ORDER BY service_type
  `).all(participantId);
  return rows;
}

function listAllRegistrations() {
  return db.prepare(`
    SELECT r.*, p.code, p.name, p.installed_capacity
    FROM ancillary_service_registrations r
    JOIN market_participants p ON r.participant_id = p.id
    ORDER BY p.code, r.service_type
  `).all();
}

function submitAncillaryBid(tradingDayId, participantId, data) {
  const td = getTradingDayById(tradingDayId);
  if (!td) throw new Error('交易日不存在');
  if (!isBiddingOpen(tradingDayId)) throw new Error('报价窗口已关闭');

  const p = getParticipantById(participantId);
  if (!p) throw new Error('市场主体不存在');
  if (p.type !== 'generator') throw new Error('只有发电侧可以提交辅助服务报价');

  const { bids } = data;
  if (!Array.isArray(bids) || bids.length === 0) {
    throw new Error('报价数据不能为空');
  }

  const registrations = getAncillaryRegistrations(participantId);
  const regMap = {};
  for (const r of registrations) regMap[r.service_type] = r;

  const tx = db.transaction(() => {
    const deleteStmt = db.prepare(`
      DELETE FROM ancillary_service_bids
      WHERE trading_day_id = ? AND participant_id = ? AND service_type = ?
    `);
    const insertStmt = db.prepare(`
      INSERT INTO ancillary_service_bids
      (id, trading_day_id, participant_id, service_type, capacity_price, mileage_price)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const bid of bids) {
      if (!['frequency', 'reserve'].includes(bid.service_type)) {
        throw new Error('辅助服务类型必须是 frequency 或 reserve');
      }

      const reg = regMap[bid.service_type];
      if (!reg) {
        throw new Error(`该电厂未注册${bid.service_type === 'frequency' ? '调频' : '备用'}服务能力`);
      }

      if (bid.capacity_price == null || bid.capacity_price < 0) {
        throw new Error('容量报价无效');
      }

      if (bid.service_type === 'frequency') {
        if (bid.mileage_price == null || bid.mileage_price < 0) {
          throw new Error('调频里程报价无效');
        }
        deleteStmt.run(tradingDayId, participantId, 'frequency');
        insertStmt.run(uuidv4(), tradingDayId, participantId, 'frequency', bid.capacity_price, bid.mileage_price);
      }

      if (bid.service_type === 'reserve') {
        deleteStmt.run(tradingDayId, participantId, 'reserve');
        insertStmt.run(uuidv4(), tradingDayId, participantId, 'reserve', bid.capacity_price, null);
      }
    }
  });

  tx();
  return getAncillaryBids(tradingDayId, participantId);
}

function getAncillaryBids(tradingDayId, participantId) {
  return db.prepare(`
    SELECT service_type, capacity_price, mileage_price
    FROM ancillary_service_bids
    WHERE trading_day_id = ? AND participant_id = ?
    ORDER BY service_type
  `).all(tradingDayId, participantId);
}

function getAncillaryBidsByTradingDay(tradingDayId) {
  return db.prepare(`
    SELECT ab.*, p.code, p.name, p.installed_capacity
    FROM ancillary_service_bids ab
    JOIN market_participants p ON ab.participant_id = p.id
    WHERE ab.trading_day_id = ?
    ORDER BY ab.service_type, ab.capacity_price
  `).all(tradingDayId);
}

function executeAncillaryClearing(tradingDayId) {
  const td = getTradingDayById(tradingDayId);
  if (!td) throw new Error('交易日不存在');
  if (td.status === 'bidding') throw new Error('现货市场尚未出清，不能执行辅助服务出清');

  const existingClearing = db.prepare(
    'SELECT id FROM ancillary_clearing_results WHERE trading_day_id = ?'
  ).all(tradingDayId);
  if (existingClearing.length > 0) throw new Error('辅助服务已出清');

  if (!td.frequency_demand && !td.reserve_demand) {
    throw new Error('未设定辅助服务需求量');
  }

  const spotAllocations = db.prepare(`
    SELECT ca.participant_id, cr.hour, ca.final_dispatch, p.installed_capacity
    FROM clearing_results cr
    JOIN clearing_allocations ca ON cr.id = ca.clearing_result_id
    JOIN market_participants p ON ca.participant_id = p.id
    WHERE cr.trading_day_id = ? AND p.type = 'generator'
    ORDER BY ca.participant_id, cr.hour
  `).all(tradingDayId);

  const remainingCapacity = {};
  for (const alloc of spotAllocations) {
    if (!remainingCapacity[alloc.participant_id]) {
      remainingCapacity[alloc.participant_id] = {
        installed_capacity: alloc.installed_capacity,
        hourly: {},
        minRemaining: alloc.installed_capacity
      };
    }
    const remaining = alloc.installed_capacity - alloc.final_dispatch;
    remainingCapacity[alloc.participant_id].hourly[alloc.hour] = remaining;
    remainingCapacity[alloc.participant_id].minRemaining = Math.min(
      remainingCapacity[alloc.participant_id].minRemaining, remaining
    );
  }

  const allGenerators = listParticipants('generator');
  for (const gen of allGenerators) {
    if (!remainingCapacity[gen.id]) {
      remainingCapacity[gen.id] = {
        installed_capacity: gen.installed_capacity,
        hourly: {},
        minRemaining: gen.installed_capacity
      };
      for (let h = 0; h < 24; h++) {
        remainingCapacity[gen.id].hourly[h] = gen.installed_capacity;
      }
    }
  }

  let freqClearingResult = null;
  let freqWinners = [];

  if (td.frequency_demand > 0) {
    const freqBids = db.prepare(`
      SELECT ab.participant_id, ab.capacity_price, ab.mileage_price,
             r.adjustable_capacity, r.response_rate, p.installed_capacity
      FROM ancillary_service_bids ab
      JOIN ancillary_service_registrations r ON ab.participant_id = r.participant_id AND r.service_type = 'frequency'
      JOIN market_participants p ON ab.participant_id = p.id
      WHERE ab.trading_day_id = ? AND ab.service_type = 'frequency'
      ORDER BY ab.capacity_price ASC
    `).all(tradingDayId);

    let accumulated = 0;
    let clearingPrice = 0;
    let mileageClearingPrice = 0;

    for (const bid of freqBids) {
      if (accumulated >= td.frequency_demand) break;

      const rem = remainingCapacity[bid.participant_id];
      if (!rem) continue;

      const maxCapacity = Math.min(bid.adjustable_capacity, rem.minRemaining);
      if (maxCapacity <= 0) continue;

      const needed = td.frequency_demand - accumulated;
      const allocated = Math.min(maxCapacity, needed);

      freqWinners.push({
        participant_id: bid.participant_id,
        allocated_capacity: allocated,
        capacity_price: bid.capacity_price,
        mileage_price: bid.mileage_price
      });

      accumulated += allocated;
      clearingPrice = bid.capacity_price;
      mileageClearingPrice = bid.mileage_price;
    }

    if (freqWinners.length > 0) {
      freqClearingResult = {
        clearing_price: clearingPrice,
        mileage_clearing_price: mileageClearingPrice,
        total_cleared_capacity: accumulated,
        winners: freqWinners
      };
    }
  }

  const freqWinningByParticipant = {};
  for (const w of freqWinners) {
    freqWinningByParticipant[w.participant_id] = w.allocated_capacity;
  }

  let reserveClearingResult = null;
  let reserveWinners = [];

  if (td.reserve_demand > 0) {
    const reserveBids = db.prepare(`
      SELECT ab.participant_id, ab.capacity_price,
             r.reserve_capacity, r.startup_time, p.installed_capacity
      FROM ancillary_service_bids ab
      JOIN ancillary_service_registrations r ON ab.participant_id = r.participant_id AND r.service_type = 'reserve'
      JOIN market_participants p ON ab.participant_id = p.id
      WHERE ab.trading_day_id = ? AND ab.service_type = 'reserve'
      ORDER BY ab.capacity_price ASC
    `).all(tradingDayId);

    let accumulated = 0;
    let clearingPrice = 0;

    for (const bid of reserveBids) {
      if (accumulated >= td.reserve_demand) break;

      const rem = remainingCapacity[bid.participant_id];
      if (!rem) continue;

      const freqUsed = freqWinningByParticipant[bid.participant_id] || 0;
      const effectiveRemaining = rem.minRemaining - freqUsed;
      const maxCapacity = Math.min(bid.reserve_capacity, effectiveRemaining);
      if (maxCapacity <= 0) continue;

      const needed = td.reserve_demand - accumulated;
      const allocated = Math.min(maxCapacity, needed);

      reserveWinners.push({
        participant_id: bid.participant_id,
        allocated_capacity: allocated,
        capacity_price: bid.capacity_price
      });

      accumulated += allocated;
      clearingPrice = bid.capacity_price;
    }

    if (reserveWinners.length > 0) {
      reserveClearingResult = {
        clearing_price: clearingPrice,
        total_cleared_capacity: accumulated,
        winners: reserveWinners
      };
    }
  }

  const tx = db.transaction(() => {
    const insertResult = db.prepare(`
      INSERT INTO ancillary_clearing_results
      (id, trading_day_id, service_type, clearing_price, mileage_clearing_price, total_cleared_capacity)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertAllocation = db.prepare(`
      INSERT INTO ancillary_clearing_allocations
      (id, clearing_result_id, participant_id, hour, cleared_capacity, clearing_price, mileage_clearing_price)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    if (freqClearingResult) {
      const crId = uuidv4();
      insertResult.run(
        crId, tradingDayId, 'frequency',
        freqClearingResult.clearing_price,
        freqClearingResult.mileage_clearing_price,
        freqClearingResult.total_cleared_capacity
      );

      for (const winner of freqClearingResult.winners) {
        for (let h = 0; h < 24; h++) {
          const rem = remainingCapacity[winner.participant_id];
          const hourRemaining = rem.hourly[h] != null ? rem.hourly[h] : rem.minRemaining;
          const hourCapacity = Math.min(winner.allocated_capacity, hourRemaining);
          insertAllocation.run(
            uuidv4(), crId, winner.participant_id, h,
            hourCapacity,
            freqClearingResult.clearing_price,
            freqClearingResult.mileage_clearing_price
          );
        }
      }
    }

    if (reserveClearingResult) {
      const crId = uuidv4();
      insertResult.run(
        crId, tradingDayId, 'reserve',
        reserveClearingResult.clearing_price,
        null,
        reserveClearingResult.total_cleared_capacity
      );

      for (const winner of reserveClearingResult.winners) {
        const freqUsed = freqWinningByParticipant[winner.participant_id] || 0;
        for (let h = 0; h < 24; h++) {
          const rem = remainingCapacity[winner.participant_id];
          const hourRemaining = rem.hourly[h] != null ? rem.hourly[h] : rem.minRemaining;
          const hourCapacity = Math.min(winner.allocated_capacity, hourRemaining - freqUsed);
          insertAllocation.run(
            uuidv4(), crId, winner.participant_id, h,
            Math.max(0, hourCapacity),
            reserveClearingResult.clearing_price,
            null
          );
        }
      }
    }
  });

  tx();

  return getAncillaryClearingResults(tradingDayId);
}

function getAncillaryClearingResults(tradingDayId) {
  const td = getTradingDayById(tradingDayId);
  if (!td) throw new Error('交易日不存在');

  const results = db.prepare(`
    SELECT * FROM ancillary_clearing_results
    WHERE trading_day_id = ?
    ORDER BY service_type
  `).all(tradingDayId);

  const output = {
    trading_day_id: tradingDayId,
    trade_date: td.trade_date,
    frequency: null,
    reserve: null
  };

  for (const cr of results) {
    const allocations = db.prepare(`
      SELECT aa.participant_id, p.code, p.name, aa.hour, aa.cleared_capacity,
             aa.clearing_price, aa.mileage_clearing_price
      FROM ancillary_clearing_allocations aa
      JOIN market_participants p ON aa.participant_id = p.id
      WHERE aa.clearing_result_id = ?
      ORDER BY p.code, aa.hour
    `).all(cr.id);

    const byParticipant = {};
    for (const a of allocations) {
      if (!byParticipant[a.participant_id]) {
        byParticipant[a.participant_id] = {
          participant_id: a.participant_id,
          code: a.code,
          name: a.name,
          hourly: []
        };
      }
      byParticipant[a.participant_id].hourly.push({
        hour: a.hour,
        cleared_capacity: a.cleared_capacity,
        clearing_price: a.clearing_price,
        mileage_clearing_price: a.mileage_clearing_price
      });
    }

    const section = {
      clearing_price: cr.clearing_price,
      mileage_clearing_price: cr.mileage_clearing_price,
      total_cleared_capacity: cr.total_cleared_capacity,
      winners: Object.values(byParticipant)
    };

    if (cr.service_type === 'frequency') {
      output.frequency = section;
    } else {
      output.reserve = section;
    }
  }

  return output;
}

function getAncillaryClearingByParticipant(tradingDayId, participantId) {
  const td = getTradingDayById(tradingDayId);
  if (!td) throw new Error('交易日不存在');
  const p = getParticipantById(participantId);
  if (!p) throw new Error('市场主体不存在');

  const results = db.prepare(`
    SELECT cr.service_type, cr.clearing_price, cr.mileage_clearing_price, cr.total_cleared_capacity,
           aa.hour, aa.cleared_capacity
    FROM ancillary_clearing_results cr
    JOIN ancillary_clearing_allocations aa ON cr.id = aa.clearing_result_id
    WHERE cr.trading_day_id = ? AND aa.participant_id = ?
    ORDER BY cr.service_type, aa.hour
  `).all(tradingDayId, participantId);

  const output = {
    participant: { id: p.id, code: p.code, name: p.name, type: p.type },
    trading_day_id: tradingDayId,
    trade_date: td.trade_date,
    frequency: null,
    reserve: null
  };

  for (const row of results) {
    const section = row.service_type === 'frequency' ? 'frequency' : 'reserve';
    if (!output[section]) {
      output[section] = {
        clearing_price: row.clearing_price,
        mileage_clearing_price: row.mileage_clearing_price,
        total_cleared_capacity: row.total_cleared_capacity,
        hourly: []
      };
    }
    output[section].hourly.push({
      hour: row.hour,
      cleared_capacity: row.cleared_capacity
    });
  }

  return output;
}

function getFrequencyExemptionMap(tradingDayId) {
  const rows = db.prepare(`
    SELECT aa.participant_id, aa.hour, aa.cleared_capacity
    FROM ancillary_clearing_results cr
    JOIN ancillary_clearing_allocations aa ON cr.id = aa.clearing_result_id
    WHERE cr.trading_day_id = ? AND cr.service_type = 'frequency'
  `).all(tradingDayId);

  const map = {};
  for (const row of rows) {
    if (!map[row.participant_id]) map[row.participant_id] = {};
    map[row.participant_id][row.hour] = row.cleared_capacity;
  }
  return map;
}

function submitActualMileage(participantId, month, actualMileage) {
  const p = getParticipantById(participantId);
  if (!p) throw new Error('市场主体不存在');
  if (p.type !== 'generator') throw new Error('只有发电侧可以提交调频里程');

  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('月份格式应为 YYYY-MM');
  if (actualMileage == null || actualMileage < 0) throw new Error('实际调频里程无效');

  db.prepare(`
    INSERT INTO ancillary_mileage_submissions (id, participant_id, month, actual_mileage)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(participant_id, month) DO UPDATE SET actual_mileage = excluded.actual_mileage
  `).run(uuidv4(), participantId, month, actualMileage);

  return { participant_id: participantId, month, actual_mileage: actualMileage };
}

function executeAncillarySettlement(month) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('月份格式应为 YYYY-MM');

  const tradingDays = db.prepare(`
    SELECT id, trade_date FROM trading_days
    WHERE trade_date LIKE ? AND status != 'bidding'
    ORDER BY trade_date
  `).all(month + '%');

  if (tradingDays.length === 0) {
    throw new Error(`${month} 月没有已出清的交易日`);
  }

  const participantSet = new Set();
  const clearingData = {};

  for (const td of tradingDays) {
    const allocs = db.prepare(`
      SELECT cr.service_type, cr.clearing_price, cr.mileage_clearing_price,
             aa.participant_id, aa.hour, aa.cleared_capacity
      FROM ancillary_clearing_results cr
      JOIN ancillary_clearing_allocations aa ON cr.id = aa.clearing_result_id
      WHERE cr.trading_day_id = ?
      ORDER BY aa.participant_id, cr.service_type, aa.hour
    `).all(td.id);

    for (const a of allocs) {
      if (a.cleared_capacity <= 0) continue;
      participantSet.add(a.participant_id);
      const key = `${a.participant_id}_${a.service_type}`;
      if (!clearingData[key]) {
        clearingData[key] = {
          participant_id: a.participant_id,
          service_type: a.service_type,
          winning_hours: 0,
          total_winning_capacity: 0,
          total_capacity_fee: 0,
          mileage_clearing_prices: [],
          weighted_capacity_price: 0
        };
      }
      clearingData[key].winning_hours += 1;
      clearingData[key].total_winning_capacity += a.cleared_capacity;
      clearingData[key].total_capacity_fee += a.cleared_capacity * a.clearing_price;
      if (a.service_type === 'frequency' && a.mileage_clearing_price != null) {
        clearingData[key].mileage_clearing_prices.push({
          price: a.mileage_clearing_price,
          capacity: a.cleared_capacity
        });
      }
    }
  }

  const tx = db.transaction(() => {
    db.prepare(`
      DELETE FROM ancillary_service_settlements WHERE month = ?
    `).run(month);

    const insertStmt = db.prepare(`
      INSERT INTO ancillary_service_settlements
      (id, participant_id, month, service_type, winning_hours, total_winning_capacity,
       capacity_clearing_price, capacity_fee, mileage_clearing_price, actual_mileage,
       mileage_fee, total_fee)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const [key, data] of Object.entries(clearingData)) {
      const capacityFee = data.total_capacity_fee;
      const avgCapacityClearingPrice = data.total_winning_capacity > 0
        ? capacityFee / data.total_winning_capacity
        : 0;

      let mileageClearingPrice = null;
      let actualMileage = null;
      let mileageFee = null;

      if (data.service_type === 'frequency') {
        if (data.mileage_clearing_prices.length > 0) {
          const totalCap = data.mileage_clearing_prices.reduce((s, m) => s + m.capacity, 0);
          mileageClearingPrice = totalCap > 0
            ? data.mileage_clearing_prices.reduce((s, m) => s + m.price * m.capacity, 0) / totalCap
            : 0;
        }

        const mileageRow = db.prepare(`
          SELECT actual_mileage FROM ancillary_mileage_submissions
          WHERE participant_id = ? AND month = ?
        `).get(data.participant_id, month);

        actualMileage = mileageRow ? mileageRow.actual_mileage : 0;
        mileageFee = mileageClearingPrice != null ? actualMileage * mileageClearingPrice : 0;
      }

      const totalFee = capacityFee + (mileageFee || 0);

      insertStmt.run(
        uuidv4(),
        data.participant_id,
        month,
        data.service_type,
        data.winning_hours,
        data.total_winning_capacity,
        avgCapacityClearingPrice,
        capacityFee,
        mileageClearingPrice,
        actualMileage,
        mileageFee,
        totalFee
      );
    }
  });

  tx();

  return getAncillarySettlementSummary(month);
}

function getAncillarySettlement(participantId, month) {
  const p = getParticipantById(participantId);
  if (!p) throw new Error('市场主体不存在');

  const settlements = db.prepare(`
    SELECT * FROM ancillary_service_settlements
    WHERE participant_id = ? AND month = ?
    ORDER BY service_type
  `).all(participantId, month);

  return {
    participant: { id: p.id, code: p.code, name: p.name, type: p.type },
    month,
    settlements
  };
}

function getAncillarySettlementSummary(month) {
  const settlements = db.prepare(`
    SELECT s.*, p.code, p.name, p.type
    FROM ancillary_service_settlements s
    JOIN market_participants p ON s.participant_id = p.id
    WHERE s.month = ?
    ORDER BY p.code, s.service_type
  `).all(month);

  const byParticipant = {};
  for (const s of settlements) {
    if (!byParticipant[s.participant_id]) {
      byParticipant[s.participant_id] = {
        participant_id: s.participant_id,
        code: s.code,
        name: s.name,
        type: s.type,
        frequency: null,
        reserve: null,
        total_ancillary_fee: 0
      };
    }
    const entry = {
      winning_hours: s.winning_hours,
      capacity_fee: s.capacity_fee,
      mileage_clearing_price: s.mileage_clearing_price,
      actual_mileage: s.actual_mileage,
      mileage_fee: s.mileage_fee,
      total_fee: s.total_fee
    };
    if (s.service_type === 'frequency') {
      byParticipant[s.participant_id].frequency = entry;
    } else {
      byParticipant[s.participant_id].reserve = entry;
    }
    byParticipant[s.participant_id].total_ancillary_fee += s.total_fee;
  }

  return {
    month,
    participants: Object.values(byParticipant),
    total_ancillary_fee: Object.values(byParticipant).reduce((sum, p) => sum + p.total_ancillary_fee, 0)
  };
}

function getComprehensiveSettlementView(tradingDayId, participantId) {
  const td = getTradingDayById(tradingDayId);
  if (!td) throw new Error('交易日不存在');
  const p = getParticipantById(participantId);
  if (!p) throw new Error('市场主体不存在');

  const spotRows = db.prepare(`
    SELECT hour, item_type, contract_id, volume, direction, unit_price, amount, exempt_amount
    FROM settlement_details
    WHERE trading_day_id = ? AND participant_id = ?
    ORDER BY hour, item_type
  `).all(tradingDayId, participantId);

  const hourlyMap = {};
  for (let h = 0; h < 24; h++) {
    hourlyMap[h] = {
      hour: h,
      spot: { items: [] },
      contract: { items: [] },
      deviation: null,
      ancillary_frequency: null,
      ancillary_reserve: null
    };
  }

  let totalSpotAmount = 0;
  let totalContractAmount = 0;
  let totalDeviationAmount = 0;
  let totalExemptAmount = 0;

  for (const row of spotRows) {
    if (row.item_type === 'spot') {
      hourlyMap[row.hour].spot.items.push({
        volume: row.volume,
        direction: row.direction,
        unit_price: row.unit_price,
        amount: row.amount
      });
      totalSpotAmount += row.amount;
    } else if (row.item_type === 'contract') {
      hourlyMap[row.hour].contract.items.push({
        contract_id: row.contract_id,
        volume: row.volume,
        direction: row.direction,
        unit_price: row.unit_price,
        amount: row.amount
      });
      totalContractAmount += row.amount;
    } else if (row.item_type === 'deviation') {
      hourlyMap[row.hour].deviation = {
        volume: row.volume,
        direction: row.direction,
        unit_price: row.unit_price,
        amount: row.amount,
        exempt_amount: row.exempt_amount || 0
      };
      totalDeviationAmount += row.amount;
      totalExemptAmount += (row.exempt_amount || 0);
    }
  }

  const ancillaryAllocs = db.prepare(`
    SELECT cr.service_type, aa.hour, aa.cleared_capacity, aa.clearing_price, aa.mileage_clearing_price
    FROM ancillary_clearing_results cr
    JOIN ancillary_clearing_allocations aa ON cr.id = aa.clearing_result_id
    WHERE cr.trading_day_id = ? AND aa.participant_id = ?
    ORDER BY cr.service_type, aa.hour
  `).all(tradingDayId, participantId);

  let totalFreqFee = 0;
  let totalReserveFee = 0;
  for (const a of ancillaryAllocs) {
    const fee = a.cleared_capacity * a.clearing_price;
    if (a.service_type === 'frequency') {
      hourlyMap[a.hour].ancillary_frequency = {
        cleared_capacity: a.cleared_capacity,
        clearing_price: a.clearing_price,
        mileage_clearing_price: a.mileage_clearing_price,
        capacity_fee: fee
      };
      totalFreqFee += fee;
    } else {
      hourlyMap[a.hour].ancillary_reserve = {
        cleared_capacity: a.cleared_capacity,
        clearing_price: a.clearing_price,
        capacity_fee: fee
      };
      totalReserveFee += fee;
    }
  }

  return {
    participant: { id: p.id, code: p.code, name: p.name, type: p.type },
    trading_day_id: tradingDayId,
    trade_date: td.trade_date,
    status: td.status,
    summary: {
      spot_settlement: totalSpotAmount,
      contract_settlement: totalContractAmount,
      deviation_penalty: totalDeviationAmount,
      deviation_exemption: totalExemptAmount,
      ancillary_frequency_fee: totalFreqFee,
      ancillary_reserve_fee: totalReserveFee,
      total_ancillary_fee: totalFreqFee + totalReserveFee,
      net_settlement: totalSpotAmount + totalContractAmount + totalDeviationAmount + totalFreqFee + totalReserveFee
    },
    hourly: Object.values(hourlyMap)
  };
}

module.exports = {
  registerAncillaryService,
  getAncillaryRegistrations,
  listAllRegistrations,
  submitAncillaryBid,
  getAncillaryBids,
  getAncillaryBidsByTradingDay,
  executeAncillaryClearing,
  getAncillaryClearingResults,
  getAncillaryClearingByParticipant,
  getFrequencyExemptionMap,
  submitActualMileage,
  executeAncillarySettlement,
  getAncillarySettlement,
  getAncillarySettlementSummary,
  getComprehensiveSettlementView
};
