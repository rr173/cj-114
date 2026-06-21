const { v4: uuidv4 } = require('uuid');
const db = require('../utils/db');
const { getTradingDayById } = require('./tradingDayService');
const { listParticipants, getParticipantById, isRenewableGenerator } = require('./participantService');
const { getAllGeneratorBidsByHour, getAllConsumerBidsByHour } = require('./biddingService');
const { listPriceZones, getParticipantZone } = require('./priceZoneService');
const { listTieLines } = require('./tieLineService');
const supervisionService = require('./supervisionService');
const greenCertificateService = require('./greenCertificateService');
const capacityMarketService = require('./capacityMarketService');

function buildSupplyCurve(bids) {
  const sortedBids = [...bids].sort((a, b) => a.price - b.price);
  
  const segments = [];
  let cumulativeCapacity = 0;
  const participantTotal = {};

  for (const bid of sortedBids) {
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
  const sortedBids = [...bids].sort((a, b) => b.max_price - a.max_price);
  
  const segments = [];
  let cumulativeDemand = 0;

  for (const bid of sortedBids) {
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

  const totalDemand = demandCurve[demandCurve.length - 1].cumulative_demand;
  const totalSupply = supplyCurve[supplyCurve.length - 1].cumulative_capacity;

  if (totalSupply === 0 || totalDemand === 0) {
    return { clearingPrice: 0, clearingVolume: 0 };
  }

  let clearingPrice = 0;
  let clearingVolume = 0;

  for (let i = 0; i < supplyCurve.length; i++) {
    const p = supplyCurve[i].price;
    const sQty = supplyCurve[i].cumulative_capacity;

    let dQty = 0;
    for (let j = 0; j < demandCurve.length; j++) {
      if (demandCurve[j].price >= p) {
        dQty = demandCurve[j].cumulative_demand;
      } else {
        break;
      }
    }

    if (sQty >= dQty && dQty > 0) {
      clearingPrice = p;
      clearingVolume = dQty;
      break;
    }

    clearingVolume = sQty;
    clearingPrice = p;
  }

  if (clearingVolume === 0) {
    return { clearingPrice: 0, clearingVolume: 0 };
  }

  if (totalSupply < totalDemand) {
    let demandMarginalPrice = 0;
    for (let j = 0; j < demandCurve.length; j++) {
      if (demandCurve[j].cumulative_demand >= totalSupply) {
        demandMarginalPrice = demandCurve[j].price;
        break;
      }
      demandMarginalPrice = demandCurve[j].price;
    }
    clearingPrice = Math.max(clearingPrice, demandMarginalPrice);
    clearingVolume = totalSupply;
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
      if (adjusted[h] > adjusted[h - 1] + gen.ramp_rate) {
        adjusted[h] = adjusted[h - 1] + gen.ramp_rate;
        adjustmentReasons[`${pid}_${h}`] = (adjustmentReasons[`${pid}_${h}`] || '') +
          `[爬坡上调限制: 截断高时段]`;
      }
    }

    for (let h = 23; h >= 1; h--) {
      if (adjusted[h - 1] > adjusted[h] + gen.ramp_rate) {
        adjusted[h - 1] = adjusted[h] + gen.ramp_rate;
        adjustmentReasons[`${pid}_${h - 1}`] = (adjustmentReasons[`${pid}_${h - 1}`] || '') +
          `[爬坡下调限制: 截断高时段]`;
      }
    }

    for (let h = 0; h < 24; h++) {
      adjusted[h] = Math.min(adjusted[h], gen.installed_capacity);
      if (adjusted[h] < 0) adjusted[h] = 0;
      if (adjusted[h] > 0 && adjusted[h] < gen.min_output) {
        adjusted[h] = gen.min_output;
      }
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

function getZoneBids(genBids, conBids, zoneId) {
  const zoneGenBids = genBids.filter(bid => {
    const zone = getParticipantZone(bid.participant_id);
    return zone && zone.id === zoneId;
  });
  const zoneConBids = conBids.filter(bid => {
    const zone = getParticipantZone(bid.participant_id);
    return zone && zone.id === zoneId;
  });
  return { zoneGenBids, zoneConBids };
}

function calculateZoneNetExport(genAllocs, conAllocs) {
  let totalGen = 0;
  let totalCon = 0;
  for (const vol of Object.values(genAllocs)) totalGen += vol;
  for (const vol of Object.values(conAllocs)) totalCon += vol;
  return totalGen - totalCon;
}

function calculateZoneGenerationAtPrice(supplyCurve, price) {
  let total = 0;
  for (const seg of supplyCurve) {
    if (seg.price <= price) {
      total = seg.cumulative_capacity;
    } else {
      break;
    }
  }
  return total;
}

function calculateZoneDemandAtPrice(demandCurve, price) {
  let total = 0;
  for (const seg of demandCurve) {
    if (seg.price >= price) {
      total = seg.cumulative_demand;
    } else {
      break;
    }
  }
  return total;
}

function performZonalClearing(genBids, conBids, zones, tieLines) {
  if (zones.length < 2 || tieLines.length === 0) {
    return null;
  }

  const zoneMap = {};
  for (const z of zones) zoneMap[z.id] = z;

  const allBidParticipants = new Set([
    ...genBids.map(b => b.participant_id),
    ...conBids.map(b => b.participant_id)
  ]);

  const unassignedParticipants = [];
  for (const pid of allBidParticipants) {
    const zone = getParticipantZone(pid);
    if (!zone) {
      unassignedParticipants.push(pid);
    }
  }

  if (unassignedParticipants.length > 0) {
    throw new Error(
      `以下市场主体未分配到任何电价区，无法进行分区出清: ${unassignedParticipants.join(', ')}`
    );
  }

  const tieLine = tieLines[0];
  const fromZone = zoneMap[tieLine.from_zone_id];
  const toZone = zoneMap[tieLine.to_zone_id];
  if (!fromZone || !toZone) return null;

  const unifiedSupplyCurve = buildSupplyCurve(genBids);
  const unifiedDemandCurve = buildDemandCurve(conBids);
  const unifiedResult = findClearingPoint(unifiedSupplyCurve, unifiedDemandCurve);
  const unifiedPrice = unifiedResult.clearingPrice;

  const { zoneGenBids: fromGenBids, zoneConBids: fromConBids } = getZoneBids(
    genBids, conBids, fromZone.id
  );
  const { zoneGenBids: toGenBids, zoneConBids: toConBids } = getZoneBids(
    genBids, conBids, toZone.id
  );

  const fromSupplyCurve = buildSupplyCurve(fromGenBids);
  const fromDemandCurve = buildDemandCurve(fromConBids);
  const toSupplyCurve = buildSupplyCurve(toGenBids);
  const toDemandCurve = buildDemandCurve(toConBids);

  const fromGenAtUnified = calculateZoneGenerationAtPrice(fromSupplyCurve, unifiedPrice);
  const fromConAtUnified = calculateZoneDemandAtPrice(fromDemandCurve, unifiedPrice);
  const fromNetExport = fromGenAtUnified - fromConAtUnified;

  const flowMagnitude = Math.abs(fromNetExport);
  const maxCapacity = tieLine.max_transfer_capacity;

  if (flowMagnitude <= maxCapacity) {
    const unifiedGenAllocs = calculateGeneratorAllocations(
      unifiedSupplyCurve, unifiedPrice, unifiedResult.clearingVolume
    );
    const unifiedConAllocs = calculateConsumerAllocations(
      unifiedDemandCurve, unifiedPrice, unifiedResult.clearingVolume
    );

    return {
      type: 'unified',
      unifiedPrice: unifiedPrice,
      unifiedVolume: unifiedResult.clearingVolume,
      tieLineFlow: flowMagnitude,
      tieLineDirection: fromNetExport >= 0 ? 'forward' : 'reverse',
      isCongested: false,
      congestionLevel: 0,
      genAllocs: unifiedGenAllocs,
      conAllocs: unifiedConAllocs
    };
  }

  const exportZoneId = fromNetExport >= 0 ? fromZone.id : toZone.id;
  const importZoneId = fromNetExport >= 0 ? toZone.id : fromZone.id;

  const isFromExport = exportZoneId === fromZone.id;
  const exportGenBids = isFromExport ? fromGenBids : toGenBids;
  const exportConBids = isFromExport ? fromConBids : toConBids;
  const importGenBids = isFromExport ? toGenBids : fromGenBids;
  const importConBids = isFromExport ? toConBids : fromConBids;

  const exportSupplyCurve = buildSupplyCurve(exportGenBids);
  const exportDemandWithVirtual = [
    ...exportConBids,
    { participant_id: 'virtual_tie_load', max_price: 999999, demand: maxCapacity }
  ];
  const exportDemandCurve = buildDemandCurve(exportDemandWithVirtual);
  const exportResult = findClearingPoint(exportSupplyCurve, exportDemandCurve);
  const exportPrice = exportResult.clearingPrice;

  const virtualTieGenPrice = exportPrice > 0 ? exportPrice : unifiedPrice;
  const importSupplyWithVirtual = [
    ...importGenBids,
    { participant_id: 'virtual_tie_gen', price: virtualTieGenPrice, capacity: maxCapacity, installed_capacity: maxCapacity }
  ];
  const importSupplyCurve = buildSupplyCurve(importSupplyWithVirtual);
  const importDemandCurve = buildDemandCurve(importConBids);
  const importResult = findClearingPoint(importSupplyCurve, importDemandCurve);

  let importPrice = importResult.clearingPrice;
  if (importGenBids.length === 0 && importPrice <= 0) {
    const sortedImportDemand = [...importConBids].sort((a, b) => b.max_price - a.max_price);
    let cumDemand = 0;
    for (const bid of sortedImportDemand) {
      cumDemand += bid.demand;
      if (cumDemand >= maxCapacity) {
        importPrice = bid.max_price;
        break;
      }
    }
    if (importPrice <= 0 && sortedImportDemand.length > 0) {
      importPrice = sortedImportDemand[sortedImportDemand.length - 1].max_price;
    }
    if (importPrice <= 0) {
      importPrice = virtualTieGenPrice;
    }
  }

  const importPriceFinal = importPrice;

  const exportGenAllocs = calculateGeneratorAllocations(
    exportSupplyCurve, exportPrice, exportResult.clearingVolume
  );
  const exportConAllocsRaw = calculateConsumerAllocations(
    exportDemandCurve, exportPrice, exportResult.clearingVolume
  );
  const exportConAllocs = {};
  for (const [pid, vol] of Object.entries(exportConAllocsRaw)) {
    if (pid !== 'virtual_tie_load') {
      exportConAllocs[pid] = vol;
    }
  }

  const importGenAllocsRaw = calculateGeneratorAllocations(
    importSupplyCurve, importPriceFinal, importResult.clearingVolume
  );
  const importGenAllocs = {};
  for (const [pid, vol] of Object.entries(importGenAllocsRaw)) {
    if (pid !== 'virtual_tie_gen') {
      importGenAllocs[pid] = vol;
    }
  }
  const importConAllocs = calculateConsumerAllocations(
    importDemandCurve, importPriceFinal, importResult.clearingVolume
  );

  const totalGenAllocs = { ...exportGenAllocs, ...importGenAllocs };
  const totalConAllocs = { ...exportConAllocs, ...importConAllocs };

  const actualFlow = maxCapacity;
  const congestionLevel = (flowMagnitude - maxCapacity) / flowMagnitude;

  const zoneResults = {};
  zoneResults[exportZoneId] = {
    zoneId: exportZoneId,
    clearingPrice: exportPrice,
    clearingVolume: exportResult.clearingVolume - maxCapacity,
    netExport: maxCapacity,
    genAllocs: exportGenAllocs,
    conAllocs: exportConAllocs
  };
  zoneResults[importZoneId] = {
    zoneId: importZoneId,
    clearingPrice: importPriceFinal,
    clearingVolume: importResult.clearingVolume,
    netExport: -maxCapacity,
    genAllocs: importGenAllocs,
    conAllocs: importConAllocs
  };

  return {
    type: 'zoned',
    unifiedPrice: unifiedPrice,
    unifiedVolume: unifiedResult.clearingVolume,
    tieLineFlow: actualFlow,
    tieLineDirection: exportZoneId === fromZone.id ? 'forward' : 'reverse',
    isCongested: true,
    congestionLevel: congestionLevel,
    zoneResults,
    exportZoneId,
    importZoneId,
    exportPrice,
    importPrice: importPriceFinal,
    tieLineId: tieLine.id,
    genAllocs: totalGenAllocs,
    conAllocs: totalConAllocs
  };
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

  const zones = listPriceZones();
  const tieLines = listTieLines();
  const hasZonalConfig = zones.length >= 2 && tieLines.length > 0;

  const initialHourlyAllocations = {};
  const clearingResults = [];
  const zonalClearingResults = [];

  for (let h = 0; h < 24; h++) {
    const genBids = getAllGeneratorBidsByHour(tradingDayId, h);
    const conBids = consumerHourlyBids[h];

    let genAllocs, conAllocs, clearingPrice, clearingVolume;
    let clearingType = 'unified';
    let zonalResult = null;

    if (hasZonalConfig) {
      zonalResult = performZonalClearing(genBids, conBids, zones, tieLines);
      
      if (zonalResult && zonalResult.type === 'zoned') {
        clearingType = 'zoned';
        clearingPrice = zonalResult.unifiedPrice;
        clearingVolume = zonalResult.unifiedVolume;
        genAllocs = zonalResult.genAllocs;
        conAllocs = zonalResult.conAllocs;
      } else if (zonalResult && zonalResult.type === 'unified') {
        clearingType = 'unified';
        clearingPrice = zonalResult.unifiedPrice;
        clearingVolume = zonalResult.unifiedVolume;
        genAllocs = zonalResult.genAllocs;
        conAllocs = zonalResult.conAllocs;
      } else {
        const supplyCurve = buildSupplyCurve(genBids);
        const demandCurve = buildDemandCurve(conBids);
        const result = findClearingPoint(supplyCurve, demandCurve);
        clearingPrice = result.clearingPrice;
        clearingVolume = result.clearingVolume;
        genAllocs = calculateGeneratorAllocations(supplyCurve, clearingPrice, clearingVolume);
        conAllocs = calculateConsumerAllocations(demandCurve, clearingPrice, clearingVolume);
      }
    } else {
      const supplyCurve = buildSupplyCurve(genBids);
      const demandCurve = buildDemandCurve(conBids);
      const result = findClearingPoint(supplyCurve, demandCurve);
      clearingPrice = result.clearingPrice;
      clearingVolume = result.clearingVolume;
      genAllocs = calculateGeneratorAllocations(supplyCurve, clearingPrice, clearingVolume);
      conAllocs = calculateConsumerAllocations(demandCurve, clearingPrice, clearingVolume);
    }

    initialHourlyAllocations[h] = {
      generators: genAllocs,
      consumers: conAllocs,
      clearingPrice,
      clearingVolume,
      clearingType,
      zonalResult
    };

    clearingResults.push({
      hour: h,
      clearingPrice,
      clearingVolume,
      clearingType,
      zonalResult
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
      INSERT INTO clearing_results (id, trading_day_id, hour, clearing_price, clearing_volume, clearing_type)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const insertAllocation = db.prepare(`
      INSERT INTO clearing_allocations (id, clearing_result_id, participant_id, initial_allocation, adjusted_allocation, final_dispatch, adjustment_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const insertZoneClearing = db.prepare(`
      INSERT INTO zone_clearing_results (id, clearing_result_id, zone_id, clearing_price, clearing_volume, net_export)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const insertTieLineFlow = db.prepare(`
      INSERT INTO tie_line_flows (id, clearing_result_id, tie_line_id, flow_direction, actual_flow, congestion_level, is_congested)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const insertCongestionSurplus = db.prepare(`
      INSERT INTO congestion_surplus (id, trading_day_id, hour, tie_line_id, total_surplus, from_zone_share, to_zone_share)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const clearingResultIds = {};
    for (const result of clearingResults) {
      const crId = uuidv4();
      clearingResultIds[result.hour] = crId;
      insertClearing.run(
        crId, tradingDayId, result.hour, 
        result.clearingPrice, result.clearingVolume,
        result.clearingType
      );

      if (result.zonalResult && result.zonalResult.type === 'zoned') {
        for (const [zoneId, zr] of Object.entries(result.zonalResult.zoneResults)) {
          insertZoneClearing.run(
            uuidv4(), crId, zoneId,
            zr.clearingPrice, zr.clearingVolume, zr.netExport
          );
        }

        const tl = tieLines[0];
        insertTieLineFlow.run(
          uuidv4(), crId, tl.id,
          result.zonalResult.tieLineDirection,
          result.zonalResult.tieLineFlow,
          result.zonalResult.congestionLevel,
          result.zonalResult.isCongested ? 1 : 0
        );

        const priceDiff = result.zonalResult.importPrice - result.zonalResult.exportPrice;
        const totalSurplus = priceDiff * result.zonalResult.tieLineFlow;
        const fromShare = totalSurplus * 0.5;
        const toShare = totalSurplus * 0.5;

        insertCongestionSurplus.run(
          uuidv4(), tradingDayId, result.hour, tl.id,
          totalSurplus, fromShare, toShare
        );
      } else if (result.zonalResult && result.zonalResult.type === 'unified') {
        const tl = tieLines[0];
        insertTieLineFlow.run(
          uuidv4(), crId, tl.id,
          result.zonalResult.tieLineDirection,
          result.zonalResult.tieLineFlow,
          0, 0
        );
      }
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

  try {
    supervisionService.runFullAnalysis(tradingDayId);
  } catch (e) {
    console.error('[Supervision] 监管分析异常:', e.message);
  }

  try {
    const gcResult = greenCertificateService.issueGreenCertificatesForClearing(tradingDayId);
    console.log(`[GreenCertificate] 绿证发放完成: 发放${gcResult.total_certificates_issued}张, 自动划转${gcResult.total_auto_transferred}张`);
  } catch (e) {
    console.error('[GreenCertificate] 绿证发放异常:', e.message);
  }

  try {
    const capacityCheck = capacityMarketService.checkCapacityAvailability(tradingDayId);
    if (capacityCheck.checked && capacityCheck.new_shortage_events > 0) {
      console.log(`[CapacityMarket] 容量可用性检查完成: 发现${capacityCheck.new_shortage_events}个容量缺失事件`);
    }
  } catch (e) {
    console.error('[CapacityMarket] 容量可用性检查异常:', e.message);
  }

  return getClearingSummary(tradingDayId);
}

function getClearingSummary(tradingDayId) {
  const td = getTradingDayById(tradingDayId);
  if (!td) throw new Error('交易日不存在');

  const results = db.prepare(`
    SELECT cr.id, cr.hour, cr.clearing_price, cr.clearing_volume, cr.clearing_type,
           ca.participant_id, ca.initial_allocation, ca.adjusted_allocation,
           ca.final_dispatch, ca.adjustment_reason,
           p.type, p.name, p.code
    FROM clearing_results cr
    LEFT JOIN clearing_allocations ca ON cr.id = ca.clearing_result_id
    LEFT JOIN market_participants p ON ca.participant_id = p.id
    WHERE cr.trading_day_id = ?
    ORDER BY cr.hour, p.type, p.code
  `).all(tradingDayId);

  const zoneResults = db.prepare(`
    SELECT zcr.*, pz.code as zone_code, pz.name as zone_name, cr.hour
    FROM zone_clearing_results zcr
    JOIN clearing_results cr ON zcr.clearing_result_id = cr.id
    JOIN price_zones pz ON zcr.zone_id = pz.id
    WHERE cr.trading_day_id = ?
    ORDER BY cr.hour
  `).all(tradingDayId);

  const tieLineFlows = db.prepare(`
    SELECT tlf.*, tl.code as tie_line_code, tl.name as tie_line_name,
           cr.hour
    FROM tie_line_flows tlf
    JOIN clearing_results cr ON tlf.clearing_result_id = cr.id
    JOIN tie_lines tl ON tlf.tie_line_id = tl.id
    WHERE cr.trading_day_id = ?
    ORDER BY cr.hour
  `).all(tradingDayId);

  const hourly = {};
  for (const row of results) {
    if (!hourly[row.hour]) {
      hourly[row.hour] = {
        hour: row.hour,
        clearing_price: row.clearing_price,
        clearing_volume: row.clearing_volume,
        clearing_type: row.clearing_type || 'unified',
        generators: [],
        consumers: [],
        zone_results: [],
        tie_line_flows: []
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

  for (const zr of zoneResults) {
    if (hourly[zr.hour]) {
      hourly[zr.hour].zone_results.push({
        zone_id: zr.zone_id,
        zone_code: zr.zone_code,
        zone_name: zr.zone_name,
        clearing_price: zr.clearing_price,
        clearing_volume: zr.clearing_volume,
        net_export: zr.net_export
      });
    }
  }

  for (const tf of tieLineFlows) {
    if (hourly[tf.hour]) {
      hourly[tf.hour].tie_line_flows.push({
        tie_line_id: tf.tie_line_id,
        tie_line_code: tf.tie_line_code,
        tie_line_name: tf.tie_line_name,
        flow_direction: tf.flow_direction,
        actual_flow: tf.actual_flow,
        congestion_level: tf.congestion_level,
        is_congested: tf.is_congested === 1
      });
    }
  }

  const hours = [];
  for (let h = 0; h < 24; h++) {
    hours.push(hourly[h] || { 
      hour: h, 
      clearing_price: 0, 
      clearing_volume: 0, 
      clearing_type: 'unified',
      generators: [], 
      consumers: [],
      zone_results: [],
      tie_line_flows: []
    });
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
    SELECT cr.hour, cr.clearing_price, cr.clearing_type,
           ca.initial_allocation, ca.adjusted_allocation,
           ca.final_dispatch, ca.adjustment_reason
    FROM clearing_results cr
    JOIN clearing_allocations ca ON cr.id = ca.clearing_result_id
    WHERE cr.trading_day_id = ? AND ca.participant_id = ?
    ORDER BY cr.hour
  `).all(tradingDayId, participantId);

  const zone = getParticipantZone(participantId);

  return {
    participant: p,
    zone: zone,
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
  findClearingPoint,
  performZonalClearing
};
