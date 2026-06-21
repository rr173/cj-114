const { v4: uuidv4 } = require('uuid');
const db = require('../utils/db');
const { getTieLineById, listTieLines } = require('./tieLineService');
const { getPriceZoneById, getParticipantZone } = require('./priceZoneService');
const { getParticipantById, listParticipants } = require('./participantService');
const { getTradingDayById, getTradingDayByDate } = require('./tradingDayService');

function generateAuctionNo(month) {
  const yearPart = month.replace('-', '');
  const count = db.prepare(`SELECT COUNT(*) as cnt FROM ftr_auctions WHERE month = ?`).get(month).cnt;
  return `FTR${yearPart}${String(count + 1).padStart(3, '0')}`;
}

function openAuction(data) {
  const {
    month,
    tie_line_id,
    direction_zone_from,
    direction_zone_to,
    total_capacity_mw,
    bid_start_time,
    bid_end_time,
    max_single_participant_ratio = 0.3
  } = data;

  if (!month || !tie_line_id || !direction_zone_from || !direction_zone_to || total_capacity_mw == null) {
    throw new Error('月份、联络线ID、方向(起/终区)、拍卖总容量为必填项');
  }

  if (total_capacity_mw <= 0) {
    throw new Error('拍卖总容量必须大于0');
  }

  if (direction_zone_from === direction_zone_to) {
    throw new Error('起点区和终点区不能相同');
  }

  const tieLine = getTieLineById(tie_line_id);
  if (!tieLine) {
    throw new Error('联络线不存在');
  }

  const maxCapacity = tieLine.max_transfer_capacity * 0.8;
  if (total_capacity_mw > maxCapacity) {
    throw new Error(`拍卖总容量不能超过联络线物理容量的80% (${maxCapacity.toFixed(2)}MW)`);
  }

  const fromZone = getPriceZoneById(direction_zone_from);
  if (!fromZone) throw new Error('起点电价区不存在');
  const toZone = getPriceZoneById(direction_zone_to);
  if (!toZone) throw new Error('终点电价区不存在');

  if (tieLine.from_zone_id !== direction_zone_from && tieLine.to_zone_id !== direction_zone_from) {
    throw new Error('起点区必须是联络线连接的电价区之一');
  }
  if (tieLine.from_zone_id !== direction_zone_to && tieLine.to_zone_id !== direction_zone_to) {
    throw new Error('终点区必须是联络线连接的电价区之一');
  }

  const existingActive = db.prepare(`
    SELECT id FROM ftr_auctions 
    WHERE tie_line_id = ? AND month = ? AND status IN ('pending', 'bidding')
  `).get(tie_line_id, month);
  if (existingActive) {
    throw new Error('该联络线本月已有进行中的拍卖');
  }

  const id = uuidv4();
  const auctionNo = generateAuctionNo(month);

  db.prepare(`
    INSERT INTO ftr_auctions (
      id, auction_no, month, tie_line_id, direction_zone_from, direction_zone_to,
      total_capacity_mw, max_single_participant_ratio, status,
      bid_start_time, bid_end_time
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, auctionNo, month, tie_line_id, direction_zone_from, direction_zone_to,
    total_capacity_mw, max_single_participant_ratio, 'bidding',
    bid_start_time || new Date().toISOString(),
    bid_end_time || null
  );

  return getAuctionById(id);
}

function getAuctionById(id) {
  const auction = db.prepare('SELECT * FROM ftr_auctions WHERE id = ?').get(id);
  if (!auction) return null;
  return enrichAuction(auction);
}

function getAuctionByNo(auctionNo) {
  const auction = db.prepare('SELECT * FROM ftr_auctions WHERE auction_no = ?').get(auctionNo);
  if (!auction) return null;
  return enrichAuction(auction);
}

function enrichAuction(auction) {
  const tieLine = getTieLineById(auction.tie_line_id);
  const fromZone = getPriceZoneById(auction.direction_zone_from);
  const toZone = getPriceZoneById(auction.direction_zone_to);

  const bids = db.prepare(`
    SELECT fb.*, p.code as participant_code, p.name as participant_name, p.type as participant_type
    FROM ftr_bids fb
    JOIN market_participants p ON fb.participant_id = p.id
    WHERE fb.auction_id = ?
    ORDER BY fb.bid_price DESC, fb.created_at ASC
  `).all(auction.id);

  const totalBidCapacity = bids.reduce((s, b) => s + b.bid_capacity_mw, 0);
  const totalClearedCapacity = bids.reduce((s, b) => s + (b.cleared_capacity_mw || 0), 0);

  return {
    ...auction,
    tie_line: tieLine,
    direction_from_zone: fromZone ? { id: fromZone.id, code: fromZone.code, name: fromZone.name } : null,
    direction_to_zone: toZone ? { id: toZone.id, code: toZone.code, name: toZone.name } : null,
    bids: bids,
    total_bid_capacity_mw: totalBidCapacity,
    total_cleared_capacity_mw: totalClearedCapacity,
    bid_count: bids.length
  };
}

function listAuctions(filters = {}) {
  let sql = 'SELECT id FROM ftr_auctions WHERE 1=1';
  const params = [];

  if (filters.month) {
    sql += ' AND month = ?';
    params.push(filters.month);
  }
  if (filters.status) {
    sql += ' AND status = ?';
    params.push(filters.status);
  }
  if (filters.tie_line_id) {
    sql += ' AND tie_line_id = ?';
    params.push(filters.tie_line_id);
  }

  sql += ' ORDER BY created_at DESC';
  const rows = db.prepare(sql).all(...params);
  return rows.map(r => getAuctionById(r.id));
}

function submitBid(auctionId, participantId, bidCapacityMw, bidPrice) {
  const auction = getAuctionById(auctionId);
  if (!auction) {
    throw new Error('拍卖不存在');
  }
  if (auction.status !== 'bidding') {
    throw new Error('拍卖未处于报价阶段');
  }

  const participant = getParticipantById(participantId);
  if (!participant) {
    throw new Error('市场主体不存在');
  }

  if (bidCapacityMw == null || bidCapacityMw <= 0) {
    throw new Error('报价容量必须大于0');
  }
  if (bidPrice == null || bidPrice < 0) {
    throw new Error('报价单价不能为负');
  }

  const participantZone = getParticipantZone(participantId);
  if (!participantZone) {
    throw new Error('该市场主体未分配到电价区，不能参与FTR拍卖');
  }

  const existingBids = db.prepare(`
    SELECT bid_capacity_mw, cleared_capacity_mw FROM ftr_bids 
    WHERE auction_id = ? AND participant_id = ? AND status != 'cancelled'
  `).all(auctionId, participantId);

  const maxAllowedBid = auction.total_capacity_mw * 2;
  const currentSubmitted = existingBids.reduce((s, b) => s + b.bid_capacity_mw, 0);

  if (currentSubmitted + bidCapacityMw > maxAllowedBid) {
    throw new Error(
      `该主体累计报价容量(${currentSubmitted + bidCapacityMw}MW)过大，请减少报价量`
    );
  }

  const id = uuidv4();
  db.prepare(`
    INSERT INTO ftr_bids (
      id, auction_id, participant_id, bid_capacity_mw, bid_price, status
    ) VALUES (?, ?, ?, ?, ?, 'submitted')
  `).run(id, auctionId, participantId, bidCapacityMw, bidPrice);

  return getBidById(id);
}

function getBidById(id) {
  const bid = db.prepare(`
    SELECT fb.*, p.code as participant_code, p.name as participant_name, p.type as participant_type,
           fa.auction_no, fa.month
    FROM ftr_bids fb
    JOIN market_participants p ON fb.participant_id = p.id
    JOIN ftr_auctions fa ON fb.auction_id = fa.id
    WHERE fb.id = ?
  `).get(id);
  return bid || null;
}

function cancelBid(bidId) {
  const bid = getBidById(bidId);
  if (!bid) throw new Error('报价不存在');
  if (bid.status !== 'submitted') throw new Error('该报价状态不允许取消');

  const auction = getAuctionById(bid.auction_id);
  if (!auction || auction.status !== 'bidding') throw new Error('拍卖已结束，无法取消报价');

  db.prepare(`UPDATE ftr_bids SET status = 'cancelled' WHERE id = ?`).run(bidId);
  return getBidById(bidId);
}

function executeAuctionClearing(auctionId) {
  const auction = getAuctionById(auctionId);
  if (!auction) throw new Error('拍卖不存在');
  if (auction.status !== 'bidding' && auction.status !== 'closed') {
    throw new Error('拍卖状态不允许出清');
  }

  const tieLine = getTieLineById(auction.tie_line_id);
  const maxPerParticipant = tieLine.max_transfer_capacity * auction.max_single_participant_ratio;

  const tx = db.transaction(() => {
    db.prepare(`UPDATE ftr_auctions SET status = 'closed' WHERE id = ?`).run(auctionId);

    const validBids = db.prepare(`
      SELECT * FROM ftr_bids 
      WHERE auction_id = ? AND status = 'submitted'
      ORDER BY bid_price DESC, created_at ASC
    `).all(auctionId);

    let remainingCapacity = auction.total_capacity_mw;
    const participantAllocated = {};
    let marginalPrice = 0;
    let totalCleared = 0;

    const bidResults = [];

    for (const bid of validBids) {
      const pid = bid.participant_id;
      if (!participantAllocated[pid]) participantAllocated[pid] = 0;

      const canAllocate = Math.min(
        maxPerParticipant - participantAllocated[pid],
        remainingCapacity,
        bid.bid_capacity_mw
      );

      if (canAllocate <= 0) {
        bidResults.push({ ...bid, cleared_capacity_mw: 0, status: 'rejected' });
        continue;
      }

      marginalPrice = bid.bid_price;
      participantAllocated[pid] += canAllocate;
      remainingCapacity -= canAllocate;
      totalCleared += canAllocate;

      const isPartial = canAllocate < bid.bid_capacity_mw;
      bidResults.push({
        ...bid,
        cleared_capacity_mw: canAllocate,
        status: isPartial ? 'partial' : 'accepted'
      });

      if (remainingCapacity <= 0) break;
    }

    const processedIds = new Set(bidResults.map(b => b.id));
    for (const bid of validBids) {
      if (!processedIds.has(bid.id)) {
        bidResults.push({ ...bid, cleared_capacity_mw: 0, status: 'rejected' });
      }
    }

    const finalClearingPrice = totalCleared > 0 ? marginalPrice : 0;

    for (const result of bidResults) {
      if (result.cleared_capacity_mw > 0) {
        result.clearing_price = finalClearingPrice;
        result.payment_amount = result.cleared_capacity_mw * finalClearingPrice;
      } else {
        result.clearing_price = null;
        result.payment_amount = 0;
      }
    }

    const updateBidStmt = db.prepare(`
      UPDATE ftr_bids 
      SET status = ?, cleared_capacity_mw = ?, clearing_price = ?, payment_amount = ?
      WHERE id = ?
    `);

    const insertHoldingStmt = db.prepare(`
      INSERT INTO ftr_holdings (
        id, auction_id, bid_id, participant_id, month, tie_line_id,
        direction_zone_from, direction_zone_to, holding_capacity_mw,
        clearing_price, total_payment, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
    `);

    for (const result of bidResults) {
      updateBidStmt.run(
        result.status,
        result.cleared_capacity_mw,
        result.clearing_price,
        result.payment_amount,
        result.id
      );
      if (result.cleared_capacity_mw > 0) {
        insertHoldingStmt.run(
          uuidv4(),
          auctionId,
          result.id,
          result.participant_id,
          auction.month,
          auction.tie_line_id,
          auction.direction_zone_from,
          auction.direction_zone_to,
          result.cleared_capacity_mw,
          result.clearing_price,
          result.payment_amount
        );
      }
    }

    db.prepare(`
      UPDATE ftr_auctions 
      SET status = 'cleared', clearing_price = ?, total_cleared_capacity_mw = ?
      WHERE id = ?
    `).run(finalClearingPrice, totalCleared, auctionId);
  });

  tx();
  return getAuctionById(auctionId);
}

function getParticipantHoldings(participantId, filters = {}) {
  const participant = getParticipantById(participantId);
  if (!participant) throw new Error('市场主体不存在');

  let sql = `
    SELECT fh.*, fa.auction_no, fa.month, fa.clearing_price as auction_clearing_price,
           tl.code as tie_line_code, tl.name as tie_line_name,
           fz.code as from_zone_code, fz.name as from_zone_name,
           tz.code as to_zone_code, tz.name as to_zone_name,
           p.code as participant_code, p.name as participant_name
    FROM ftr_holdings fh
    JOIN ftr_auctions fa ON fh.auction_id = fa.id
    JOIN tie_lines tl ON fh.tie_line_id = tl.id
    JOIN price_zones fz ON fh.direction_zone_from = fz.id
    JOIN price_zones tz ON fh.direction_zone_to = tz.id
    JOIN market_participants p ON fh.participant_id = p.id
    WHERE fh.participant_id = ?
  `;
  const params = [participantId];

  if (filters.month) {
    sql += ' AND fh.month = ?';
    params.push(filters.month);
  }
  if (filters.status) {
    sql += ' AND fh.status = ?';
    params.push(filters.status);
  }

  sql += ' ORDER BY fh.created_at DESC';
  return db.prepare(sql).all(...params);
}

function getActiveHoldingsForMonth(month) {
  const holdings = db.prepare(`
    SELECT fh.*, fa.auction_no, fa.month, fa.clearing_price as auction_clearing_price,
           tl.code as tie_line_code, tl.name as tie_line_name,
           tl.from_zone_id, tl.to_zone_id, tl.max_transfer_capacity,
           fz.code as from_zone_code, fz.name as from_zone_name,
           tz.code as to_zone_code, tz.name as to_zone_name,
           p.code as participant_code, p.name as participant_name
    FROM ftr_holdings fh
    JOIN ftr_auctions fa ON fh.auction_id = fa.id
    JOIN tie_lines tl ON fh.tie_line_id = tl.id
    JOIN price_zones fz ON fh.direction_zone_from = fz.id
    JOIN price_zones tz ON fh.direction_zone_to = tz.id
    JOIN market_participants p ON fh.participant_id = p.id
    WHERE fh.month = ? AND fh.status = 'active'
    ORDER BY fh.tie_line_id, fh.direction_zone_from, fh.direction_zone_to
  `).all(month);

  const byTieLineAndDirection = {};
  for (const h of holdings) {
    const key = `${h.tie_line_id}_${h.direction_zone_from}_${h.direction_zone_to}`;
    if (!byTieLineAndDirection[key]) {
      byTieLineAndDirection[key] = {
        tie_line_id: h.tie_line_id,
        tie_line_code: h.tie_line_code,
        from_zone_id: h.direction_zone_from,
        to_zone_id: h.direction_zone_to,
        from_zone_code: h.from_zone_code,
        to_zone_code: h.to_zone_code,
        total_ftr_capacity_mw: 0,
        holdings: []
      };
    }
    byTieLineAndDirection[key].total_ftr_capacity_mw += h.holding_capacity_mw;
    byTieLineAndDirection[key].holdings.push(h);
  }

  return { all_holdings: holdings, grouped: byTieLineAndDirection };
}

function executeDailyFtrSettlement(tradingDayId) {
  const td = getTradingDayById(tradingDayId);
  if (!td) throw new Error('交易日不存在');
  if (td.status !== 'cleared' && td.status !== 'settled') {
    throw new Error('交易日尚未出清，无法进行FTR结算');
  }

  const tradeDate = td.trade_date;
  const month = tradeDate.substring(0, 7);

  const existing = db.prepare(`
    SELECT id FROM ftr_daily_settlements WHERE trading_day_id = ?
  `).get(tradingDayId);
  if (existing) {
    throw new Error('该交易日已完成FTR结算');
  }

  const activeHoldings = getActiveHoldingsForMonth(month);
  const hourlyZonePrices = getHourlyZoneClearingPrices(tradingDayId);
  const hourlyTieLineFlows = getHourlyTieLineFlows(tradingDayId);

  const tx = db.transaction(() => {
    const insertSettlement = db.prepare(`
      INSERT INTO ftr_daily_settlements (
        id, trading_day_id, trade_date, hour, tie_line_id,
        congestion_price_diff, actual_flow_mw, total_congestion_surplus,
        total_ftr_payment, surplus_to_pool, settlement_note
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertItem = db.prepare(`
      INSERT INTO ftr_daily_settlement_items (
        id, settlement_id, holding_id, participant_id,
        holding_capacity_mw, congestion_price_diff,
        original_income, prorated_ratio, final_income
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (let hour = 0; hour < 24; hour++) {
      const hourZonePrices = hourlyZonePrices[hour] || {};
      const hourFlows = hourlyTieLineFlows[hour] || {};

      for (const groupKey of Object.keys(activeHoldings.grouped)) {
        const group = activeHoldings.grouped[groupKey];
        const tieLineId = group.tie_line_id;

        const flow = hourFlows[tieLineId];
        let actualFlowMw = 0;
        let flowDirection = null;
        let fromZonePrice = null;
        let toZonePrice = null;

        if (flow) {
          actualFlowMw = flow.actual_flow || 0;
          flowDirection = flow.flow_direction;

          const zoneIds = Object.keys(hourZonePrices);
          for (const zid of zoneIds) {
            if (zid === group.from_zone_id) fromZonePrice = hourZonePrices[zid].clearing_price;
            if (zid === group.to_zone_id) toZonePrice = hourZonePrices[zid].clearing_price;
          }
        }

        const zones = listPriceZonesMinimal();
        const zonesAll = zones;
        if (fromZonePrice == null) {
          const unified = getUnifiedClearingPrice(tradingDayId, hour);
          fromZonePrice = unified;
        }
        if (toZonePrice == null) {
          const unified = getUnifiedClearingPrice(tradingDayId, hour);
          toZonePrice = unified;
        }

        let effectiveFlowInFtrDirection = 0;
        if (flow && flow.flow_direction !== 'zero' && actualFlowMw > 0) {
          const flowFromZone = flow.flow_direction === 'forward'
            ? (flow.tie_line_from_zone_id || group.from_zone_id)
            : (flow.tie_line_to_zone_id || group.to_zone_id);

          if (flowFromZone === group.from_zone_id) {
            effectiveFlowInFtrDirection = actualFlowMw;
          }
        }

        let priceDiff = (toZonePrice || 0) - (fromZonePrice || 0);
        if (priceDiff < 0) priceDiff = 0;

        const totalSurplus = effectiveFlowInFtrDirection * priceDiff;
        const totalFtrCapacity = group.total_ftr_capacity_mw;

        let totalFtrPayment = 0;
        let proratedRatio = 1;

        if (totalFtrCapacity > 0 && priceDiff > 0) {
          const totalOriginalIncome = totalFtrCapacity * priceDiff;
          if (totalOriginalIncome > totalSurplus && totalSurplus > 0) {
            proratedRatio = totalSurplus / totalOriginalIncome;
          }
          totalFtrPayment = Math.min(totalOriginalIncome, totalSurplus);
        }

        const surplusToPool = Math.max(0, totalSurplus - totalFtrPayment);

        const settlementId = uuidv4();
        insertSettlement.run(
          settlementId,
          tradingDayId,
          tradeDate,
          hour,
          tieLineId,
          priceDiff,
          effectiveFlowInFtrDirection,
          totalSurplus,
          totalFtrPayment,
          surplusToPool,
          totalFtrCapacity > effectiveFlowInFtrDirection && priceDiff > 0
            ? `FTR总容量(${totalFtrCapacity}MW)超过实际传输量，按比例分摊`
            : null
        );

        for (const holding of group.holdings) {
          const originalIncome = holding.holding_capacity_mw * priceDiff;
          const finalIncome = originalIncome * proratedRatio;

          insertItem.run(
            uuidv4(),
            settlementId,
            holding.id,
            holding.participant_id,
            holding.holding_capacity_mw,
            priceDiff,
            originalIncome,
            proratedRatio,
            finalIncome
          );
        }

        if (surplusToPool > 0) {
          addToSurplusPool(month, surplusToPool);
        }
      }
    }
  });

  tx();
  return getDailySettlement(tradingDayId);
}

function getHourlyZoneClearingPrices(tradingDayId) {
  const rows = db.prepare(`
    SELECT zcr.zone_id, zcr.clearing_price, zcr.clearing_volume, zcr.net_export, cr.hour
    FROM zone_clearing_results zcr
    JOIN clearing_results cr ON zcr.clearing_result_id = cr.id
    WHERE cr.trading_day_id = ?
    ORDER BY cr.hour
  `).all(tradingDayId);

  const hourly = {};
  for (const r of rows) {
    if (!hourly[r.hour]) hourly[r.hour] = {};
    hourly[r.hour][r.zone_id] = r;
  }
  return hourly;
}

function getHourlyTieLineFlows(tradingDayId) {
  const rows = db.prepare(`
    SELECT tlf.*, tl.from_zone_id as tie_line_from_zone_id, tl.to_zone_id as tie_line_to_zone_id, cr.hour
    FROM tie_line_flows tlf
    JOIN clearing_results cr ON tlf.clearing_result_id = cr.id
    JOIN tie_lines tl ON tlf.tie_line_id = tl.id
    WHERE cr.trading_day_id = ?
    ORDER BY cr.hour
  `).all(tradingDayId);

  const hourly = {};
  for (const r of rows) {
    if (!hourly[r.hour]) hourly[r.hour] = {};
    hourly[r.hour][r.tie_line_id] = r;
  }
  return hourly;
}

function getUnifiedClearingPrice(tradingDayId, hour) {
  const row = db.prepare(`
    SELECT clearing_price FROM clearing_results
    WHERE trading_day_id = ? AND hour = ?
  `).get(tradingDayId, hour);
  return row ? row.clearing_price : 0;
}

function listPriceZonesMinimal() {
  return db.prepare('SELECT id, code, name FROM price_zones').all();
}

function addToSurplusPool(month, amount) {
  const existing = db.prepare(`SELECT id, monthly_addition, closing_balance FROM congestion_surplus_pool WHERE month = ?`).get(month);
  if (existing) {
    db.prepare(`
      UPDATE congestion_surplus_pool 
      SET monthly_addition = monthly_addition + ?, closing_balance = closing_balance + ?
      WHERE id = ?
    `).run(amount, amount, existing.id);
  } else {
    const id = uuidv4();
    db.prepare(`
      INSERT INTO congestion_surplus_pool (id, month, opening_balance, monthly_addition, total_refunded, closing_balance, status)
      VALUES (?, ?, 0, ?, 0, ?, 'accumulating')
    `).run(id, month, amount, amount);
  }
}

function getDailySettlement(tradingDayId) {
  const td = getTradingDayById(tradingDayId);
  if (!td) throw new Error('交易日不存在');

  const settlements = db.prepare(`
    SELECT fds.*, tl.code as tie_line_code, tl.name as tie_line_name
    FROM ftr_daily_settlements fds
    JOIN tie_lines tl ON fds.tie_line_id = tl.id
    WHERE fds.trading_day_id = ?
    ORDER BY fds.hour, fds.tie_line_id
  `).all(tradingDayId);

  const settlementIds = settlements.map(s => s.id);
  let items = [];
  if (settlementIds.length > 0) {
    const placeholders = settlementIds.map(() => '?').join(',');
    items = db.prepare(`
      SELECT fdsi.*, p.code as participant_code, p.name as participant_name,
             fh.holding_capacity_mw as holding_capacity_check
      FROM ftr_daily_settlement_items fdsi
      JOIN market_participants p ON fdsi.participant_id = p.id
      JOIN ftr_holdings fh ON fdsi.holding_id = fh.id
      WHERE fdsi.settlement_id IN (${placeholders})
      ORDER BY fdsi.participant_id
    `).all(...settlementIds);
  }

  const itemsBySettlement = {};
  for (const item of items) {
    if (!itemsBySettlement[item.settlement_id]) itemsBySettlement[item.settlement_id] = [];
    itemsBySettlement[item.settlement_id].push(item);
  }

  const settlementsWithItems = settlements.map(s => ({
    ...s,
    items: itemsBySettlement[s.id] || []
  }));

  const summary = {
    trading_day_id: tradingDayId,
    trade_date: td.trade_date,
    total_congestion_surplus: settlements.reduce((s, r) => s + r.total_congestion_surplus, 0),
    total_ftr_payment: settlements.reduce((s, r) => s + r.total_ftr_payment, 0),
    total_surplus_to_pool: settlements.reduce((s, r) => s + r.surplus_to_pool, 0),
    hourly_count: settlements.length
  };

  const byHour = {};
  for (const s of settlementsWithItems) {
    if (!byHour[s.hour]) byHour[s.hour] = [];
    byHour[s.hour].push(s);
  }

  return {
    summary,
    hourly: byHour,
    settlements: settlementsWithItems,
    all_items: items
  };
}

function getDailySettlementForParticipant(tradingDayId, participantId) {
  const result = getDailySettlement(tradingDayId);
  const participant = getParticipantById(participantId);
  if (!participant) throw new Error('市场主体不存在');

  const filteredItems = result.all_items.filter(i => i.participant_id === participantId);

  return {
    participant: participant,
    trading_day_id: tradingDayId,
    trade_date: result.summary.trade_date,
    total_income: filteredItems.reduce((s, i) => s + i.final_income, 0),
    hourly_items: filteredItems
  };
}

function generateMonthlyReport(month) {
  if (!month) throw new Error('月份为必填项');

  const existingReport = db.prepare(`SELECT id FROM ftr_monthly_reports WHERE month = ?`).get(month);
  if (existingReport) {
    throw new Error('该月份已生成月报');
  }

  const auctions = listAuctions({ month });
  const allHoldings = getActiveHoldingsForMonth(month);

  const startDate = `${month}-01`;
  const endDateObj = new Date(new Date(month + '-01').getFullYear(), new Date(month + '-01').getMonth() + 1, 0);
  const endDate = endDateObj.toISOString().split('T')[0];

  const settlementTradingDays = db.prepare(`
    SELECT DISTINCT td.id, td.trade_date, td.status
    FROM ftr_daily_settlements fds
    JOIN trading_days td ON fds.trading_day_id = td.id
    WHERE td.trade_date >= ? AND td.trade_date <= ?
    ORDER BY td.trade_date
  `).all(startDate, endDate);

  const tx = db.transaction(() => {
    const reportId = uuidv4();

    const participantItems = {};
    const auctionWinners = new Set();

    for (const h of allHoldings.all_holdings) {
      if (!participantItems[h.participant_id]) {
        participantItems[h.participant_id] = {
          participant_id: h.participant_id,
          holding_capacity_mw: 0,
          monthly_income: 0,
          auction_payment: 0,
          net_benefit: 0,
          pool_refund_amount: 0
        };
      }
      participantItems[h.participant_id].holding_capacity_mw += h.holding_capacity_mw;
      participantItems[h.participant_id].auction_payment += h.total_payment;
      auctionWinners.add(h.participant_id);
    }

    let totalCongestionSurplus = 0;
    let totalFtrPaid = 0;
    let totalSurplusToPool = 0;

    for (const td of settlementTradingDays) {
      const daily = db.prepare(`
        SELECT * FROM ftr_daily_settlements WHERE trading_day_id = ?
      `).all(td.id);

      for (const ds of daily) {
        totalCongestionSurplus += ds.total_congestion_surplus;
        totalFtrPaid += ds.total_ftr_payment;
        totalSurplusToPool += ds.surplus_to_pool;
      }

      const items = db.prepare(`
        SELECT * FROM ftr_daily_settlement_items fdsi
        JOIN ftr_daily_settlements fds ON fdsi.settlement_id = fds.id
        WHERE fds.trading_day_id = ?
      `).all(td.id);

      for (const item of items) {
        if (!participantItems[item.participant_id]) {
          participantItems[item.participant_id] = {
            participant_id: item.participant_id,
            holding_capacity_mw: 0,
            monthly_income: 0,
            auction_payment: 0,
            net_benefit: 0,
            pool_refund_amount: 0
          };
        }
        participantItems[item.participant_id].monthly_income += item.final_income;
      }
    }

    const pool = db.prepare(`SELECT * FROM congestion_surplus_pool WHERE month = ?`).get(month);
    let poolRefundTotal = 0;

    if (pool && pool.closing_balance > 0) {
      const consumerPurchases = getConsumerMonthlyPurchases(month, startDate, endDate);
      const totalMarketPurchase = consumerPurchases.reduce((s, c) => s + c.total_purchase_mwh, 0);

      if (totalMarketPurchase > 0) {
        const refundPoolId = pool.id;
        const insertRefund = db.prepare(`
          INSERT INTO congestion_surplus_refunds (
            id, pool_id, month, participant_id,
            total_purchase_mwh, total_market_purchase_mwh,
            share_ratio, refund_amount
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        for (const cp of consumerPurchases) {
          const shareRatio = cp.total_purchase_mwh / totalMarketPurchase;
          const refundAmount = pool.closing_balance * shareRatio;
          poolRefundTotal += refundAmount;

          insertRefund.run(
            uuidv4(),
            refundPoolId,
            month,
            cp.participant_id,
            cp.total_purchase_mwh,
            totalMarketPurchase,
            shareRatio,
            refundAmount
          );

          if (!participantItems[cp.participant_id]) {
            participantItems[cp.participant_id] = {
              participant_id: cp.participant_id,
              holding_capacity_mw: 0,
              monthly_income: 0,
              auction_payment: 0,
              net_benefit: 0,
              pool_refund_amount: 0
            };
          }
          participantItems[cp.participant_id].pool_refund_amount += refundAmount;
        }

        db.prepare(`
          UPDATE congestion_surplus_pool 
          SET total_refunded = ?, closing_balance = closing_balance - ?, status = 'refunded'
          WHERE id = ?
        `).run(poolRefundTotal, poolRefundTotal, pool.id);
      }
    }

    for (const pid of Object.keys(participantItems)) {
      const pi = participantItems[pid];
      pi.net_benefit = pi.monthly_income - pi.auction_payment + (pi.pool_refund_amount || 0);
    }

    let totalHoldingCapacity = 0;
    let totalAuctionPayment = 0;
    let totalSettlementIncome = 0;
    let totalNetBenefit = 0;

    for (const pi of Object.values(participantItems)) {
      totalHoldingCapacity += pi.holding_capacity_mw;
      totalAuctionPayment += pi.auction_payment;
      totalSettlementIncome += pi.monthly_income;
      totalNetBenefit += pi.net_benefit;
    }

    db.prepare(`
      INSERT INTO ftr_monthly_reports (
        id, month, total_auctions, total_ftr_holders,
        total_holding_capacity_mw, total_auction_payment,
        total_settlement_income, total_net_benefit,
        total_congestion_surplus, total_ftr_paid,
        total_surplus_to_pool, pool_refund_total, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'finalized')
    `).run(
      reportId, month, auctions.length, auctionWinners.size,
      totalHoldingCapacity, totalAuctionPayment,
      totalSettlementIncome, totalNetBenefit,
      totalCongestionSurplus, totalFtrPaid,
      totalSurplusToPool, poolRefundTotal
    );

    const insertReportItem = db.prepare(`
      INSERT INTO ftr_monthly_report_items (
        id, report_id, participant_id, holding_capacity_mw,
        monthly_income, auction_payment, net_benefit, pool_refund_amount
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const [pid, pi] of Object.entries(participantItems)) {
      insertReportItem.run(
        uuidv4(), reportId, pid,
        pi.holding_capacity_mw, pi.monthly_income,
        pi.auction_payment, pi.net_benefit,
        pi.pool_refund_amount || 0
      );
    }
  });

  tx();
  return getMonthlyReport(month);
}

function getConsumerMonthlyPurchases(month, startDate, endDate) {
  const rows = db.prepare(`
    SELECT 
      ca.participant_id,
      SUM(ca.final_dispatch) as total_purchase_mwh
    FROM clearing_allocations ca
    JOIN clearing_results cr ON ca.clearing_result_id = cr.id
    JOIN trading_days td ON cr.trading_day_id = td.id
    JOIN market_participants p ON ca.participant_id = p.id
    WHERE p.type = 'consumer' AND td.trade_date >= ? AND td.trade_date <= ?
    GROUP BY ca.participant_id
  `).all(startDate, endDate);

  return rows.map(r => ({
    participant_id: r.participant_id,
    total_purchase_mwh: r.total_purchase_mwh || 0
  }));
}

function getMonthlyReport(month) {
  const report = db.prepare(`SELECT * FROM ftr_monthly_reports WHERE month = ?`).get(month);
  if (!report) return null;

  const items = db.prepare(`
    SELECT fmri.*, p.code as participant_code, p.name as participant_name, p.type as participant_type
    FROM ftr_monthly_report_items fmri
    JOIN market_participants p ON fmri.participant_id = p.id
    WHERE fmri.report_id = ?
    ORDER BY p.type, fmri.net_benefit DESC
  `).all(report.id);

  const pool = db.prepare(`SELECT * FROM congestion_surplus_pool WHERE month = ?`).get(month);
  let refundDetails = [];
  if (pool) {
    refundDetails = db.prepare(`
      SELECT csr.*, p.code as participant_code, p.name as participant_name
      FROM congestion_surplus_refunds csr
      JOIN market_participants p ON csr.participant_id = p.id
      WHERE csr.pool_id = ?
      ORDER BY csr.refund_amount DESC
    `).all(pool.id);
  }

  return {
    ...report,
    items: items,
    surplus_pool: pool ? {
      ...pool,
      refund_details: refundDetails
    } : null
  };
}

function getSurplusPool(month) {
  const pool = db.prepare(`SELECT * FROM congestion_surplus_pool WHERE month = ?`).get(month);
  if (!pool) {
    return {
      month,
      opening_balance: 0,
      monthly_addition: 0,
      total_refunded: 0,
      closing_balance: 0,
      status: 'no_data',
      refund_details: []
    };
  }

  const refundDetails = db.prepare(`
    SELECT csr.*, p.code as participant_code, p.name as participant_name
    FROM congestion_surplus_refunds csr
    JOIN market_participants p ON csr.participant_id = p.id
    WHERE csr.pool_id = ?
    ORDER BY csr.refund_amount DESC
  `).all(pool.id);

  return { ...pool, refund_details: refundDetails };
}

function getClearingPriceTrend() {
  const rows = db.prepare(`
    SELECT 
      fa.month,
      fa.auction_no,
      fa.clearing_price,
      fa.total_cleared_capacity_mw,
      fa.total_capacity_mw,
      fa.direction_zone_from,
      fa.direction_zone_to,
      tl.code as tie_line_code,
      fz.code as from_zone_code,
      tz.code as to_zone_code
    FROM ftr_auctions fa
    JOIN tie_lines tl ON fa.tie_line_id = tl.id
    JOIN price_zones fz ON fa.direction_zone_from = fz.id
    JOIN price_zones tz ON fa.direction_zone_to = tz.id
    WHERE fa.status = 'cleared' AND fa.clearing_price IS NOT NULL
    ORDER BY fa.month ASC, fa.created_at ASC
  `).all();

  const byMonth = {};
  for (const r of rows) {
    if (!byMonth[r.month]) byMonth[r.month] = [];
    byMonth[r.month].push(r);
  }

  return {
    trend: rows,
    by_month: byMonth,
    total_auctions: rows.length
  };
}

function listParticipantBids(participantId, filters = {}) {
  const participant = getParticipantById(participantId);
  if (!participant) throw new Error('市场主体不存在');

  let sql = `
    SELECT fb.*, fa.auction_no, fa.month, fa.status as auction_status,
           fa.direction_zone_from, fa.direction_zone_to,
           fz.code as from_zone_code, tz.code as to_zone_code,
           tl.code as tie_line_code
    FROM ftr_bids fb
    JOIN ftr_auctions fa ON fb.auction_id = fa.id
    JOIN price_zones fz ON fa.direction_zone_from = fz.id
    JOIN price_zones tz ON fa.direction_zone_to = tz.id
    JOIN tie_lines tl ON fa.tie_line_id = tl.id
    WHERE fb.participant_id = ?
  `;
  const params = [participantId];

  if (filters.month) {
    sql += ' AND fa.month = ?';
    params.push(filters.month);
  }
  if (filters.status) {
    sql += ' AND fb.status = ?';
    params.push(filters.status);
  }

  sql += ' ORDER BY fb.created_at DESC';
  return db.prepare(sql).all(...params);
}

module.exports = {
  openAuction,
  getAuctionById,
  getAuctionByNo,
  listAuctions,
  submitBid,
  getBidById,
  cancelBid,
  executeAuctionClearing,
  getParticipantHoldings,
  getActiveHoldingsForMonth,
  executeDailyFtrSettlement,
  getDailySettlement,
  getDailySettlementForParticipant,
  generateMonthlyReport,
  getMonthlyReport,
  getSurplusPool,
  getClearingPriceTrend,
  listParticipantBids
};
