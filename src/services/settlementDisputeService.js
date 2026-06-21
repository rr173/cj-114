const { v4: uuidv4 } = require('uuid');
const db = require('../utils/db');
const { getTradingDayById } = require('./tradingDayService');
const { getParticipantById } = require('./participantService');
const { getDecompositionByDate } = require('./contractService');
const { getParticipantZone, listPriceZones } = require('./priceZoneService');
const { getIntradayNetVolumes } = require('./intradayService');

const POSITIVE_DEVIATION_RATIO = 0.8;
const NEGATIVE_DEVIATION_RATIO = 1.2;
const EPSILON = 0.0001;

const DISPUTE_TYPES = ['deviation_error', 'clearing_price_error', 'contract_decomposition_error'];
const OPEN_STATUSES = ['pending', 'accepted', 'recalculating', 'reviewing'];
const WITHDRAWABLE_STATUSES = ['pending', 'accepted'];
const RECALCULATABLE_STATUSES = ['accepted'];
const REVIEWABLE_STATUSES = ['reviewing'];

function _getZoneClearingPrices(tradingDayId) {
  const zonePrices = {};
  const rows = db.prepare(`
    SELECT cr.hour, zcr.zone_id, zcr.clearing_price
    FROM zone_clearing_results zcr
    JOIN clearing_results cr ON zcr.clearing_result_id = cr.id
    WHERE cr.trading_day_id = ?
  `).all(tradingDayId);

  for (const row of rows) {
    if (!zonePrices[row.hour]) zonePrices[row.hour] = {};
    zonePrices[row.hour][row.zone_id] = row.clearing_price;
  }
  return zonePrices;
}

function _getClearingTypes(tradingDayId) {
  const types = {};
  const rows = db.prepare(`
    SELECT hour, clearing_type FROM clearing_results
    WHERE trading_day_id = ?
  `).all(tradingDayId);
  for (const row of rows) {
    types[row.hour] = row.clearing_type || 'unified';
  }
  return types;
}

function _listParticipants() {
  return db.prepare('SELECT * FROM market_participants').all();
}

function _hasOpenDispute(tradingDayId, participantId) {
  const placeholders = OPEN_STATUSES.map(() => '?').join(',');
  const row = db.prepare(`
    SELECT id FROM settlement_disputes
    WHERE trading_day_id = ? AND participant_id = ?
    AND status IN (${placeholders})
    LIMIT 1
  `).get(tradingDayId, participantId, ...OPEN_STATUSES);
  return !!row;
}

function _updateDisputeStatus(disputeId, status, rejectReason = null) {
  if (rejectReason) {
    db.prepare(`
      UPDATE settlement_disputes
      SET status = ?, reject_reason = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(status, rejectReason, disputeId);
  } else {
    db.prepare(`
      UPDATE settlement_disputes
      SET status = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(status, disputeId);
  }
}

function _enrichDispute(dispute) {
  const td = getTradingDayById(dispute.trading_day_id);
  const p = getParticipantById(dispute.participant_id);
  return {
    ...dispute,
    trading_day: td ? {
      id: td.id,
      trade_date: td.trade_date,
      status: td.status
    } : null,
    participant: p ? {
      id: p.id,
      code: p.code,
      name: p.name,
      type: p.type
    } : null
  };
}

function createDispute(tradingDayId, participantId, disputeType, description) {
  const td = getTradingDayById(tradingDayId);
  if (!td) throw new Error('交易日不存在');
  if (td.status !== 'settled') throw new Error('只有已结算的交易日才能发起争议');

  const p = getParticipantById(participantId);
  if (!p) throw new Error('市场主体不存在');

  if (!DISPUTE_TYPES.includes(disputeType)) {
    throw new Error(`争议类型必须是: ${DISPUTE_TYPES.join(', ')}`);
  }

  if (!description || !description.trim()) {
    throw new Error('争议说明不能为空');
  }

  if (_hasOpenDispute(tradingDayId, participantId)) {
    throw new Error('该交易日该主体已有未关闭的争议');
  }

  const id = uuidv4();
  db.prepare(`
    INSERT INTO settlement_disputes
    (id, trading_day_id, participant_id, dispute_type, description, status)
    VALUES (?, ?, ?, ?, ?, 'pending')
  `).run(id, tradingDayId, participantId, disputeType, description.trim());

  return getDisputeById(id);
}

function withdrawDispute(disputeId) {
  const dispute = getDisputeById(disputeId);
  if (!dispute) throw new Error('争议不存在');

  if (!WITHDRAWABLE_STATUSES.includes(dispute.status)) {
    throw new Error('只有待受理和已受理状态的争议可以撤回');
  }

  _updateDisputeStatus(disputeId, 'withdrawn');
  return getDisputeById(disputeId);
}

function acceptDispute(disputeId) {
  const dispute = getDisputeById(disputeId);
  if (!dispute) throw new Error('争议不存在');

  if (dispute.status !== 'pending') {
    throw new Error('只有待受理状态的争议可以受理');
  }

  _updateDisputeStatus(disputeId, 'accepted');
  return getDisputeById(disputeId);
}

function listDisputesByParticipant(participantId, status = null) {
  const p = getParticipantById(participantId);
  if (!p) throw new Error('市场主体不存在');

  let sql = `
    SELECT * FROM settlement_disputes
    WHERE participant_id = ?
  `;
  const args = [participantId];

  if (status) {
    if (!['pending', 'accepted', 'recalculating', 'reviewing', 'adopted', 'rejected', 'withdrawn'].includes(status)) {
      throw new Error('无效的争议状态');
    }
    sql += ' AND status = ?';
    args.push(status);
  }

  sql += ' ORDER BY created_at DESC';
  const rows = db.prepare(sql).all(...args);
  return rows.map(r => _enrichDispute(r));
}

function listDisputesByTradingDay(tradingDayId) {
  const td = getTradingDayById(tradingDayId);
  if (!td) throw new Error('交易日不存在');

  const rows = db.prepare(`
    SELECT * FROM settlement_disputes
    WHERE trading_day_id = ?
    ORDER BY created_at DESC
  `).all(tradingDayId);

  return rows.map(r => _enrichDispute(r));
}

function getDisputeById(disputeId) {
  const row = db.prepare('SELECT * FROM settlement_disputes WHERE id = ?').get(disputeId);
  if (!row) return null;
  return _enrichDispute(row);
}

function triggerRecalculation(disputeId) {
  const dispute = getDisputeById(disputeId);
  if (!dispute) throw new Error('争议不存在');

  if (!RECALCULATABLE_STATUSES.includes(dispute.status)) {
    throw new Error('只有已受理状态的争议可以触发重算');
  }

  const td = getTradingDayById(dispute.trading_day_id);
  if (!td) throw new Error('交易日不存在');

  const tx = db.transaction(() => {
    _updateDisputeStatus(disputeId, 'recalculating');

    db.prepare(`
      DELETE FROM settlement_recalculations WHERE dispute_id = ?
    `).run(disputeId);

    const insertStmt = db.prepare(`
      INSERT INTO settlement_recalculations
      (id, dispute_id, trading_day_id, participant_id, hour, item_type, contract_id,
       volume, direction, unit_price, amount, exempt_amount)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const allocations = db.prepare(`
      SELECT cr.hour, cr.clearing_price, cr.clearing_type,
             ca.participant_id, ca.final_dispatch,
             p.type
      FROM clearing_results cr
      JOIN clearing_allocations ca ON cr.id = ca.clearing_result_id
      JOIN market_participants p ON ca.participant_id = p.id
      WHERE cr.trading_day_id = ?
      ORDER BY cr.hour, p.type
    `).all(td.id);

    const zonePrices = _getZoneClearingPrices(td.id);
    const clearingTypes = _getClearingTypes(td.id);

    const actualVolumes = db.prepare(`
      SELECT participant_id, hour, actual_volume
      FROM actual_volumes
      WHERE trading_day_id = ?
    `).all(td.id);

    const actualMap = {};
    for (const av of actualVolumes) {
      if (!actualMap[av.participant_id]) actualMap[av.participant_id] = {};
      actualMap[av.participant_id][av.hour] = av.actual_volume;
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

    const freqExemptionMap = {};
    const freqExemptRows = db.prepare(`
      SELECT aa.participant_id, aa.hour, aa.cleared_capacity
      FROM ancillary_clearing_results cr
      JOIN ancillary_clearing_allocations aa ON cr.id = aa.clearing_result_id
      WHERE cr.trading_day_id = ? AND cr.service_type = 'frequency'
    `).all(td.id);
    for (const row of freqExemptRows) {
      if (!freqExemptionMap[row.participant_id]) freqExemptionMap[row.participant_id] = {};
      freqExemptionMap[row.participant_id][row.hour] = row.cleared_capacity;
    }

    const intradayNetVolumes = getIntradayNetVolumes(td.id);

    const allPartIds = new Set();
    for (const a of allocations) allPartIds.add(a.participant_id);
    for (const d of decomposition) {
      allPartIds.add(d.buyer_id);
      allPartIds.add(d.seller_id);
    }
    for (const pid of Object.keys(intradayNetVolumes)) allPartIds.add(pid);

    const spotAllocMap = {};
    for (const alloc of allocations) {
      if (!spotAllocMap[alloc.participant_id]) spotAllocMap[alloc.participant_id] = {};
      spotAllocMap[alloc.participant_id][alloc.hour] = alloc;
    }

    for (const partId of allPartIds) {
      const participant = getParticipantById(partId);
      if (!participant) continue;

      for (let h = 0; h < 24; h++) {
        const spotAlloc = spotAllocMap[partId]?.[h];
        const spotVolume = spotAlloc?.final_dispatch || 0;
        const clearingType = clearingTypes[h] || 'unified';
        let clearingPrice = spotAlloc?.clearing_price || 0;

        if (clearingType === 'zoned' && zonePrices[h]) {
          const zone = getParticipantZone(partId);
          if (zone && zonePrices[h][zone.id]) {
            clearingPrice = zonePrices[h][zone.id];
          }
        }

        const partType = participant.type;

        const contractItems = contractMap[partId]?.[h] || [];
        let totalContractVolume = 0;
        for (const ci of contractItems) {
          totalContractVolume += ci.decomposed_energy;
        }

        const intradayHourData = intradayNetVolumes[partId]?.[h];
        let intradayNetVolume = 0;
        if (intradayHourData) {
          if (partType === 'generator') {
            intradayNetVolume = intradayHourData.sell_qty - intradayHourData.buy_qty;
          } else {
            intradayNetVolume = intradayHourData.buy_qty - intradayHourData.sell_qty;
          }
        }

        const actualVolume = actualMap[partId]?.[h] || 0;
        const totalObligation = spotVolume + totalContractVolume + intradayNetVolume;

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
            uuidv4(), disputeId, td.id, partId, h, 'contract', ci.contract_id,
            vol, ci.side, contractPrice, amount, 0
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
            uuidv4(), disputeId, td.id, partId, h, 'spot', null,
            spotVolume, partType === 'generator' ? 'sell' : 'buy', clearingPrice, spotAmount, 0
          );
        }

        if (intradayHourData) {
          const netBuyQty = intradayHourData.buy_qty;
          const netSellQty = intradayHourData.sell_qty;
          const netPosition = netBuyQty - netSellQty;

          if (Math.abs(netPosition) > EPSILON) {
            const direction = netPosition > 0 ? 'buy' : 'sell';
            const volume = Math.abs(netPosition);
            const netAmount = intradayHourData.buy_amount - intradayHourData.sell_amount;
            const unitPrice = volume > 0 ? Math.abs(netAmount) / volume : 0;

            insertStmt.run(
              uuidv4(), disputeId, td.id, partId, h, 'intraday', null,
              volume, direction, unitPrice, netAmount, 0
            );
          }
        }

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
          let exemptAmount = 0;

          if (partType === 'generator' && freqExemptionMap[partId] && freqExemptionMap[partId][h]) {
            exemptAmount = Math.min(absDeviation, freqExemptionMap[partId][h]);
          }

          const penalizedDeviation = absDeviation - exemptAmount;
          const settlementAmount = penalizedDeviation * (settlementPrice - clearingPrice);

          insertStmt.run(
            uuidv4(), disputeId, td.id, partId, h, 'deviation', null,
            absDeviation, deviationDirection, settlementPrice, settlementAmount, exemptAmount
          );
        }
      }
    }

    const congestionSurpluses = db.prepare(`
      SELECT cs.*, tl.from_zone_id, tl.to_zone_id
      FROM congestion_surplus cs
      JOIN tie_lines tl ON cs.tie_line_id = tl.id
      WHERE cs.trading_day_id = ?
    `).all(td.id);

    if (congestionSurpluses.length > 0) {
      const zones = listPriceZones();
      const zoneParticipantVolumes = {};

      for (const zone of zones) {
        zoneParticipantVolumes[zone.id] = {};
        for (const p of zone.participants) {
          zoneParticipantVolumes[zone.id][p.id] = 0;
        }
      }

      for (let h = 0; h < 24; h++) {
        for (const alloc of allocations) {
          if (alloc.hour === h && alloc.final_dispatch > 0) {
            const zone = getParticipantZone(alloc.participant_id);
            if (zone && zoneParticipantVolumes[zone.id]) {
              zoneParticipantVolumes[zone.id][alloc.participant_id] += alloc.final_dispatch;
            }
          }
        }
      }

      for (const cs of congestionSurpluses) {
        if (cs.total_surplus <= 0) continue;

        const fromZoneParticipants = zoneParticipantVolumes[cs.from_zone_id] || {};
        const toZoneParticipants = zoneParticipantVolumes[cs.to_zone_id] || {};

        const fromTotalVol = Object.values(fromZoneParticipants).reduce((s, v) => s + v, 0);
        const toTotalVol = Object.values(toZoneParticipants).reduce((s, v) => s + v, 0);

        if (fromTotalVol > 0) {
          for (const [pid, vol] of Object.entries(fromZoneParticipants)) {
            if (vol > 0) {
              const share = (vol / fromTotalVol) * cs.from_zone_share;
              insertStmt.run(
                uuidv4(), disputeId, td.id, pid, cs.hour, 'congestion_surplus', null,
                vol, 'refund', 0, share, 0
              );
            }
          }
        }

        if (toTotalVol > 0) {
          for (const [pid, vol] of Object.entries(toZoneParticipants)) {
            if (vol > 0) {
              const share = (vol / toTotalVol) * cs.to_zone_share;
              insertStmt.run(
                uuidv4(), disputeId, td.id, pid, cs.hour, 'congestion_surplus', null,
                vol, 'refund', 0, share, 0
              );
            }
          }
        }
      }
    }

    _updateDisputeStatus(disputeId, 'reviewing');
  });

  tx();

  const diffReport = getDifferenceReport(disputeId);
  if (diffReport && diffReport.summary && diffReport.summary.total_difference_count === 0) {
    _updateDisputeStatus(disputeId, 'rejected', '重算无差异');
  }

  return getDisputeById(disputeId);
}

function getDifferenceReport(disputeId) {
  const dispute = getDisputeById(disputeId);
  if (!dispute) throw new Error('争议不存在');

  if (!['recalculating', 'reviewing', 'adopted', 'rejected'].includes(dispute.status)) {
    throw new Error('该争议尚未完成重算，无法生成差异报告');
  }

  const participantId = dispute.participant_id;
  const tradingDayId = dispute.trading_day_id;

  const originalRows = db.prepare(`
    SELECT s.*, p.code, p.name, p.type
    FROM settlement_details s
    JOIN market_participants p ON s.participant_id = p.id
    WHERE s.trading_day_id = ? AND s.participant_id = ?
    ORDER BY s.hour, s.item_type
  `).all(tradingDayId, participantId);

  const recalculatedRows = db.prepare(`
    SELECT r.*, p.code, p.name, p.type
    FROM settlement_recalculations r
    JOIN market_participants p ON r.participant_id = p.id
    WHERE r.dispute_id = ? AND r.participant_id = ?
    ORDER BY r.hour, r.item_type
  `).all(disputeId, participantId);

  const originalByHour = {};
  const recalculatedByHour = {};

  for (let h = 0; h < 24; h++) {
    originalByHour[h] = { winning_volume: 0, actual_volume: 0, deviation_volume: 0, unit_price: 0, amount: 0 };
    recalculatedByHour[h] = { winning_volume: 0, actual_volume: 0, deviation_volume: 0, unit_price: 0, amount: 0 };
  }

  const actualVolumes = db.prepare(`
    SELECT hour, actual_volume
    FROM actual_volumes
    WHERE trading_day_id = ? AND participant_id = ?
    ORDER BY hour
  `).all(tradingDayId, participantId);

  for (const av of actualVolumes) {
    originalByHour[av.hour].actual_volume = av.actual_volume;
    recalculatedByHour[av.hour].actual_volume = av.actual_volume;
  }

  for (const row of originalRows) {
    const h = row.hour;
    if (row.item_type === 'spot') {
      originalByHour[h].winning_volume += row.volume;
      originalByHour[h].unit_price = row.unit_price;
      originalByHour[h].amount += row.amount;
    } else if (row.item_type === 'deviation') {
      originalByHour[h].deviation_volume += row.volume;
      originalByHour[h].amount += row.amount;
    } else {
      originalByHour[h].amount += row.amount;
    }
  }

  for (const row of recalculatedRows) {
    const h = row.hour;
    if (row.item_type === 'spot') {
      recalculatedByHour[h].winning_volume += row.volume;
      recalculatedByHour[h].unit_price = row.unit_price;
      recalculatedByHour[h].amount += row.amount;
    } else if (row.item_type === 'deviation') {
      recalculatedByHour[h].deviation_volume += row.volume;
      recalculatedByHour[h].amount += row.amount;
    } else {
      recalculatedByHour[h].amount += row.amount;
    }
  }

  const hourly = [];
  let totalDifferenceCount = 0;
  let totalOriginalAmount = 0;
  let totalRecalculatedAmount = 0;

  for (let h = 0; h < 24; h++) {
    const orig = originalByHour[h];
    const recalc = recalculatedByHour[h];

    const winningDiff = recalc.winning_volume - orig.winning_volume;
    const actualDiff = recalc.actual_volume - orig.actual_volume;
    const deviationDiff = recalc.deviation_volume - orig.deviation_volume;
    const priceDiff = recalc.unit_price - orig.unit_price;
    const amountDiff = recalc.amount - orig.amount;

    const hasDifference = Math.abs(winningDiff) >= EPSILON ||
                          Math.abs(actualDiff) >= EPSILON ||
                          Math.abs(deviationDiff) >= EPSILON ||
                          Math.abs(priceDiff) >= EPSILON ||
                          Math.abs(amountDiff) >= EPSILON;

    if (hasDifference) totalDifferenceCount++;

    const amountDiffPercent = Math.abs(orig.amount) >= EPSILON
      ? (amountDiff / Math.abs(orig.amount)) * 100
      : (Math.abs(amountDiff) >= EPSILON ? 100 : 0);

    totalOriginalAmount += orig.amount;
    totalRecalculatedAmount += recalc.amount;

    hourly.push({
      hour: h,
      original: {
        winning_volume: orig.winning_volume,
        actual_volume: orig.actual_volume,
        deviation_volume: orig.deviation_volume,
        unit_price: orig.unit_price,
        amount: orig.amount
      },
      recalculated: {
        winning_volume: recalc.winning_volume,
        actual_volume: recalc.actual_volume,
        deviation_volume: recalc.deviation_volume,
        unit_price: recalc.unit_price,
        amount: recalc.amount
      },
      difference: {
        winning_volume: winningDiff,
        actual_volume: actualDiff,
        deviation_volume: deviationDiff,
        unit_price: priceDiff,
        amount: amountDiff,
        amount_percent: amountDiffPercent
      },
      has_difference: hasDifference
    });
  }

  const totalAmountDiff = totalRecalculatedAmount - totalOriginalAmount;
  const totalAmountDiffPercent = Math.abs(totalOriginalAmount) >= EPSILON
    ? (totalAmountDiff / Math.abs(totalOriginalAmount)) * 100
    : (Math.abs(totalAmountDiff) >= EPSILON ? 100 : 0);

  return {
    dispute_id: disputeId,
    participant: dispute.participant,
    trading_day: dispute.trading_day,
    summary: {
      total_difference_count: totalDifferenceCount,
      total_original_amount: totalOriginalAmount,
      total_recalculated_amount: totalRecalculatedAmount,
      total_amount_difference: totalAmountDiff,
      total_amount_difference_percent: totalAmountDiffPercent
    },
    hourly
  };
}

function approveDispute(disputeId) {
  const dispute = getDisputeById(disputeId);
  if (!dispute) throw new Error('争议不存在');

  if (!REVIEWABLE_STATUSES.includes(dispute.status)) {
    throw new Error('只有待审核状态的争议可以审核');
  }

  const diffReport = getDifferenceReport(disputeId);
  if (diffReport.summary.total_difference_count === 0) {
    throw new Error('重算无差异，无法采纳');
  }

  const tradingDayId = dispute.trading_day_id;
  const participantId = dispute.participant_id;

  const tx = db.transaction(() => {
    db.prepare(`
      DELETE FROM settlement_dispute_refunds WHERE dispute_id = ?
    `).run(disputeId);

    const refundInsertStmt = db.prepare(`
      INSERT INTO settlement_dispute_refunds
      (id, dispute_id, participant_id, trading_day_id, hour,
       original_amount, recalculated_amount, difference_amount, refund_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const recalcRows = db.prepare(`
      SELECT * FROM settlement_recalculations
      WHERE dispute_id = ? AND participant_id = ?
    `).all(disputeId, participantId);

    const originalRows = db.prepare(`
      SELECT * FROM settlement_details
      WHERE trading_day_id = ? AND participant_id = ?
    `).all(tradingDayId, participantId);

    const originalByHour = {};
    for (const row of originalRows) {
      if (!originalByHour[row.hour]) originalByHour[row.hour] = 0;
      originalByHour[row.hour] += row.amount;
    }

    const recalcByHour = {};
    for (const row of recalcRows) {
      if (!recalcByHour[row.hour]) recalcByHour[row.hour] = 0;
      recalcByHour[row.hour] += row.amount;
    }

    for (let h = 0; h < 24; h++) {
      const origAmount = originalByHour[h] || 0;
      const recalcAmount = recalcByHour[h] || 0;
      const diff = recalcAmount - origAmount;

      if (Math.abs(diff) >= EPSILON) {
        refundInsertStmt.run(
          uuidv4(),
          disputeId,
          participantId,
          tradingDayId,
          h,
          origAmount,
          recalcAmount,
          diff,
          diff > 0 ? 'refund' : 'recovery'
        );
      }
    }

    db.prepare(`
      DELETE FROM settlement_details
      WHERE trading_day_id = ? AND participant_id = ?
    `).run(tradingDayId, participantId);

    const settlementInsertStmt = db.prepare(`
      INSERT INTO settlement_details
      (id, trading_day_id, participant_id, hour, item_type, contract_id,
       volume, direction, unit_price, amount, exempt_amount)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const row of recalcRows) {
      settlementInsertStmt.run(
        uuidv4(),
        tradingDayId,
        participantId,
        row.hour,
        row.item_type,
        row.contract_id,
        row.volume,
        row.direction,
        row.unit_price,
        row.amount,
        row.exempt_amount || 0
      );
    }

    _updateDisputeStatus(disputeId, 'adopted');
  });

  tx();

  return {
    dispute: getDisputeById(disputeId),
    refund_details: getRefundDetails(disputeId)
  };
}

function rejectDispute(disputeId, reason) {
  const dispute = getDisputeById(disputeId);
  if (!dispute) throw new Error('争议不存在');

  if (!REVIEWABLE_STATUSES.includes(dispute.status)) {
    throw new Error('只有待审核状态的争议可以审核');
  }

  if (!reason || !reason.trim()) {
    throw new Error('驳回理由不能为空');
  }

  _updateDisputeStatus(disputeId, 'rejected', reason.trim());
  return getDisputeById(disputeId);
}

function getRefundDetails(disputeId = null, participantId = null) {
  let sql = `
    SELECT r.*, d.dispute_type, d.status,
           td.trade_date,
           p.code, p.name, p.type
    FROM settlement_dispute_refunds r
    JOIN settlement_disputes d ON r.dispute_id = d.id
    JOIN trading_days td ON r.trading_day_id = td.id
    JOIN market_participants p ON r.participant_id = p.id
    WHERE 1=1
  `;
  const args = [];

  if (disputeId) {
    sql += ' AND r.dispute_id = ?';
    args.push(disputeId);
  }

  if (participantId) {
    sql += ' AND r.participant_id = ?';
    args.push(participantId);
  }

  sql += ' ORDER BY r.created_at DESC, r.hour';

  const rows = db.prepare(sql).all(...args);

  const result = rows.map(r => ({
    id: r.id,
    dispute_id: r.dispute_id,
    dispute_type: r.dispute_type,
    dispute_status: r.status,
    participant: {
      id: r.participant_id,
      code: r.code,
      name: r.name,
      type: r.type
    },
    trading_day: {
      id: r.trading_day_id,
      trade_date: r.trade_date
    },
    hour: r.hour,
    original_amount: r.original_amount,
    recalculated_amount: r.recalculated_amount,
    difference_amount: r.difference_amount,
    refund_type: r.refund_type,
    created_at: r.created_at
  }));

  if (disputeId) {
    const summary = result.reduce((acc, r) => {
      acc.total_refund += r.refund_type === 'refund' ? r.difference_amount : 0;
      acc.total_recovery += r.refund_type === 'recovery' ? Math.abs(r.difference_amount) : 0;
      acc.net_amount += r.difference_amount;
      return acc;
    }, { total_refund: 0, total_recovery: 0, net_amount: 0 });

    return {
      summary,
      details: result
    };
  }

  return result;
}

module.exports = {
  createDispute,
  withdrawDispute,
  acceptDispute,
  getDisputeById,
  listDisputesByParticipant,
  listDisputesByTradingDay,
  triggerRecalculation,
  getDifferenceReport,
  approveDispute,
  rejectDispute,
  getRefundDetails
};
