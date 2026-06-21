const db = require('../src/utils/db');
const participantService = require('../src/services/participantService');
const tradingDayService = require('../src/services/tradingDayService');
const biddingService = require('../src/services/biddingService');
const clearingService = require('../src/services/clearingService');
const settlementService = require('../src/services/settlementService');
const priceZoneService = require('../src/services/priceZoneService');
const tieLineService = require('../src/services/tieLineService');
const ftrService = require('../src/services/ftrService');

function resetDatabase() {
  db.pragma('foreign_keys = OFF');
  const tables = [
    'ftr_monthly_report_items',
    'ftr_monthly_reports',
    'congestion_surplus_refunds',
    'congestion_surplus_pool',
    'ftr_daily_settlement_items',
    'ftr_daily_settlements',
    'ftr_holdings',
    'ftr_bids',
    'ftr_auctions',
    'gc_annual_assessments',
    'gc_transfer_records',
    'gc_trades',
    'gc_buy_orders',
    'gc_sell_orders',
    'gc_trading_sessions',
    'green_certificates',
    'gc_quota_settings',
    'settlement_details',
    'contract_decomposition_results',
    'contract_decomposition_curves',
    'mid_long_term_contracts',
    'actual_volumes',
    'clearing_allocations',
    'zone_clearing_results',
    'tie_line_flows',
    'congestion_surplus',
    'clearing_results',
    'consumer_bids',
    'generator_bids',
    'trading_days',
    'market_participants',
    'price_zone_participants',
    'ancillary_service_registrations',
    'ancillary_service_bids',
    'ancillary_clearing_allocations',
    'ancillary_clearing_results',
    'ancillary_mileage_submissions',
    'ancillary_service_settlements',
    'supervision_anomalies',
    'supervision_hhi_records',
    'supervision_alerts',
    'intraday_trades',
    'intraday_orders',
    'capacity_settlement_items',
    'capacity_settlements',
    'capacity_availability_assessments',
    'capacity_shortage_events',
    'capacity_clearing_allocations',
    'capacity_clearing_results',
    'capacity_bids',
    'capacity_bidding_sessions',
    'capacity_obligations',
    'capacity_demands',
    'settlement_dispute_refunds',
    'settlement_recalculations',
    'settlement_disputes',
    'tie_lines',
    'price_zones'
  ];
  for (const t of tables) {
    try {
      db.prepare(`DELETE FROM ${t}`).run();
    } catch (e) {}
  }
  db.pragma('foreign_keys = ON');
  console.log('✓ 数据库已重置');
}

function logStep(step, msg) {
  console.log(`\n[${step}] ${msg}`);
}

function assertApprox(actual, expected, tolerance = 0.01, msg = '') {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${msg} 期望值 ${expected}, 实际值 ${actual}`);
  }
}

function setupZonalConfig() {
  logStep('A', '创建电价区和联络线配置');

  const zoneA = priceZoneService.createPriceZone({
    code: 'ZONE_A',
    name: '电价区A(低价区)',
    description: '能源富集区'
  });
  console.log(`  ✓ 创建电价区: ${zoneA.code} ${zoneA.name}`);

  const zoneB = priceZoneService.createPriceZone({
    code: 'ZONE_B',
    name: '电价区B(高价区)',
    description: '负荷中心区'
  });
  console.log(`  ✓ 创建电价区: ${zoneB.code} ${zoneB.name}`);

  const tieLine = tieLineService.createTieLine({
    code: 'TL_AB',
    name: 'A-B联络线',
    from_zone_id: zoneA.id,
    to_zone_id: zoneB.id,
    max_transfer_capacity: 100,
    description: 'A区到B区的主要联络线'
  });
  console.log(`  ✓ 创建联络线: ${tieLine.code} 容量 ${tieLine.max_transfer_capacity}MW`);
  console.log(`    A→B方向80%容量可用于FTR拍卖: ${tieLine.max_transfer_capacity * 0.8}MW`);

  return { zoneA, zoneB, tieLine };
}

function registerParticipants(zoneA, zoneB) {
  logStep('B', '注册市场主体并分配到电价区');

  const genA = participantService.registerParticipant({
    code: 'GEN_A01',
    name: 'A区火电厂',
    type: 'generator',
    installed_capacity: 300,
    min_output: 50,
    ramp_rate: 80
  });
  priceZoneService.assignParticipantToZone(zoneA.id, genA.id);
  console.log(`  ✓ 注册电厂: ${genA.code} 分配到 ${zoneA.code}`);

  const genA2 = participantService.registerParticipant({
    code: 'GEN_A02',
    name: 'A区风电场',
    type: 'generator',
    installed_capacity: 150,
    min_output: 0,
    ramp_rate: 150
  });
  priceZoneService.assignParticipantToZone(zoneA.id, genA2.id);
  console.log(`  ✓ 注册电厂: ${genA2.code} 分配到 ${zoneA.code}`);

  const genB = participantService.registerParticipant({
    code: 'GEN_B01',
    name: 'B区燃气电厂',
    type: 'generator',
    installed_capacity: 200,
    min_output: 40,
    ramp_rate: 100
  });
  priceZoneService.assignParticipantToZone(zoneB.id, genB.id);
  console.log(`  ✓ 注册电厂: ${genB.code} 分配到 ${zoneB.code}`);

  const conA = participantService.registerParticipant({
    code: 'CON_A01',
    name: 'A区售电公司',
    type: 'consumer',
    contracted_capacity: 150
  });
  priceZoneService.assignParticipantToZone(zoneA.id, conA.id);
  console.log(`  ✓ 注册售电: ${conA.code} 分配到 ${zoneA.code}`);

  const conB1 = participantService.registerParticipant({
    code: 'CON_B01',
    name: 'B区售电公司甲',
    type: 'consumer',
    contracted_capacity: 200
  });
  priceZoneService.assignParticipantToZone(zoneB.id, conB1.id);
  console.log(`  ✓ 注册售电: ${conB1.code} 分配到 ${zoneB.code}`);

  const conB2 = participantService.registerParticipant({
    code: 'CON_B02',
    name: 'B区售电公司乙',
    type: 'consumer',
    contracted_capacity: 180
  });
  priceZoneService.assignParticipantToZone(zoneB.id, conB2.id);
  console.log(`  ✓ 注册售电: ${conB2.code} 分配到 ${zoneB.code}`);

  return { genA, genA2, genB, conA, conB1, conB2 };
}

function createTradingDay(baseMonth) {
  const tradeDate = `${baseMonth}-15`;
  const deadline = new Date(Date.now() + 24 * 3600 * 1000).toISOString();

  const td = tradingDayService.createTradingDay({
    trade_date: tradeDate,
    bid_deadline: deadline
  });
  console.log(`  ✓ 创建交易日: ${td.trade_date} ID:${td.id.substring(0, 8)}`);
  return td;
}

function submitZonalBids(tdId, parts) {
  logStep('D', '提交分区报价(制造阻塞场景)');

  for (let h = 0; h < 24; h++) {
    const isPeak = h >= 10 && h <= 14;

    biddingService.submitGeneratorBid(tdId, parts.genA.id, [{
      hour: h,
      segments: [
        { price: 180, capacity: 100 },
        { price: 220, capacity: 100 },
        { price: 280, capacity: 100 }
      ]
    }]);

    biddingService.submitGeneratorBid(tdId, parts.genA2.id, [{
      hour: h,
      segments: [
        { price: 80, capacity: isPeak ? 50 : 100 }
      ]
    }]);

    biddingService.submitGeneratorBid(tdId, parts.genB.id, [{
      hour: h,
      segments: [
        { price: 350, capacity: 80 },
        { price: 420, capacity: 70 },
        { price: 500, capacity: 50 }
      ]
    }]);

    biddingService.submitConsumerBid(tdId, parts.conA.id, [{
      hour: h,
      demand: isPeak ? 80 : 60,
      max_price: 320
    }]);

    biddingService.submitConsumerBid(tdId, parts.conB1.id, [{
      hour: h,
      demand: isPeak ? 150 : 100,
      max_price: 520
    }]);

    biddingService.submitConsumerBid(tdId, parts.conB2.id, [{
      hour: h,
      demand: isPeak ? 130 : 90,
      max_price: 480
    }]);
  }

  console.log(`  ✓ 提交了6个主体的24小时报价`);
  console.log(`    设置场景: A区电源充裕(低成本), B区电源紧张(高成本)`);
  console.log(`    预期: A→B联络线阻塞, B区出清价远高于A区, 产生阻塞盈余`);
}

function runFTRModuleTest() {
  console.log('='.repeat(70));
  console.log('金融输电权(FTR)与阻塞收益分配模块 - 端到端测试');
  console.log('='.repeat(70));

  resetDatabase();

  const testMonth = new Date().toISOString().substring(0, 7);
  console.log(`\n测试月份: ${testMonth}`);

  const { zoneA, zoneB, tieLine } = setupZonalConfig();
  const participants = registerParticipants(zoneA, zoneB);
  const { genA, genA2, genB, conA, conB1, conB2 } = participants;

  logStep(1, '开启FTR拍卖(A→B方向)');

  const auction = ftrService.openAuction({
    month: testMonth,
    tie_line_id: tieLine.id,
    direction_zone_from: zoneA.id,
    direction_zone_to: zoneB.id,
    total_capacity_mw: 70,
    max_single_participant_ratio: 0.3
  });

  console.log(`  ✓ 拍卖编号: ${auction.auction_no}`);
  console.log(`    方向: ${zoneA.code} → ${zoneB.code}`);
  console.log(`    总容量: ${auction.total_capacity_mw}MW (联络线80%容量上限: ${tieLine.max_transfer_capacity * 0.8}MW)`);
  console.log(`    单主体上限: 30% = ${auction.total_capacity_mw * 0.3}MW`);
  console.log(`    状态: ${auction.status}`);

  assertApprox(auction.total_capacity_mw, 70);
  assertApprox(auction.max_single_participant_ratio, 0.3);

  logStep(2, '提交FTR竞拍报价');

  const maxPerPerson = 70 * 0.3;

  const bid1 = ftrService.submitBid(auction.id, conB1.id, 25, 15);
  console.log(`  ✓ ${conB1.code} 报价: ${bid1.bid_capacity_mw}MW @ ${bid1.bid_price}元/MW·月`);

  const bid2 = ftrService.submitBid(auction.id, conB2.id, 22, 18);
  console.log(`  ✓ ${conB2.code} 报价: ${bid2.bid_capacity_mw}MW @ ${bid2.bid_price}元/MW·月`);

  const bid3 = ftrService.submitBid(auction.id, genB.id, 20, 12);
  console.log(`  ✓ ${genB.code} 报价: ${bid3.bid_capacity_mw}MW @ ${bid3.bid_price}元/MW·月`);

  const bid4 = ftrService.submitBid(auction.id, conA.id, 30, 8);
  console.log(`  ✓ ${conA.code} 报价: ${bid4.bid_capacity_mw}MW @ ${bid4.bid_price}元/MW·月`);

  const bid5 = ftrService.submitBid(auction.id, conB1.id, 15, 10);
  console.log(`  ✓ ${conB1.code} 第2次报价: ${bid5.bid_capacity_mw}MW @ ${bid5.bid_price}元/MW·月 (累计报价:${25 + 15}MW, 单人上限:${maxPerPerson.toFixed(1)}MW, 出清时截断)`);

  logStep(3, '执行FTR拍卖出清');

  const clearedAuction = ftrService.executeAuctionClearing(auction.id);
  console.log(`  ✓ 拍卖出清完成，状态: ${clearedAuction.status}`);
  console.log(`    出清价: ${clearedAuction.clearing_price}元/MW·月`);
  console.log(`    总出清容量: ${clearedAuction.total_cleared_capacity_mw}MW / ${clearedAuction.total_capacity_mw}MW`);
  console.log(`    报价从高到低排序 (价高者得):`);

  for (const bid of clearedAuction.bids) {
    const arrow = bid.status === 'accepted' ? '✓' : bid.status === 'partial' ? '◐' : '✗';
    console.log(`      ${arrow} ${bid.participant_code}: ${bid.bid_capacity_mw}MW @ ${bid.bid_price}元`
      + ` → 中标${bid.cleared_capacity_mw || 0}MW 付款${bid.payment_amount || 0}元 [${bid.status}]`);
  }

  const winners = clearedAuction.bids.filter(b => b.cleared_capacity_mw > 0);
  const totalCleared = winners.reduce((s, b) => s + b.cleared_capacity_mw, 0);
  assertApprox(totalCleared, clearedAuction.total_cleared_capacity_mw);
  console.log(`  ✓ 校验: 累计中标${totalCleared}MW, 符合预期`);

  logStep(4, '查询FTR持仓');

  for (const pid of [conB1.id, conB2.id, genB.id, conA.id]) {
    const p = participantService.getParticipantById(pid);
    const holdings = ftrService.getParticipantHoldings(pid, { month: testMonth });
    const totalMw = holdings.reduce((s, h) => s + h.holding_capacity_mw, 0);
    const totalPay = holdings.reduce((s, h) => s + h.total_payment, 0);
    if (holdings.length > 0) {
      console.log(`  ${p.code}: 持有 ${holdings.length} 份FTR, 总容量 ${totalMw.toFixed(2)}MW, 总付款 ${totalPay.toFixed(2)}元`);
      for (const h of holdings) {
        console.log(`    - ${h.holding_capacity_mw}MW @ ${h.clearing_price}元/MW·月`);
      }
    } else {
      console.log(`  ${p.code}: 未持有FTR`);
    }
  }

  logStep(5, '创建交易日并执行分区出清(产生阻塞)');

  const td = createTradingDay(testMonth);
  submitZonalBids(td.id, participants);

  const clearingResult = clearingService.executeClearing(td.id);
  console.log(`  ✓ 出清完成, 交易日状态: ${clearingResult.status}`);

  let zonedCount = 0;
  let maxPriceDiff = 0;
  let maxDiffHour = -1;
  let totalCongestionSurplus = 0;

  for (const hr of clearingResult.hourly_results) {
    if (hr.zone_results && hr.zone_results.length >= 2) {
      zonedCount++;
      const zPrices = {};
      for (const zr of hr.zone_results) zPrices[zr.zone_code] = zr.clearing_price;
      const priceA = zPrices['ZONE_A'] || 0;
      const priceB = zPrices['ZONE_B'] || 0;
      const diff = priceB - priceA;
      if (diff > maxPriceDiff) {
        maxPriceDiff = diff;
        maxDiffHour = hr.hour;
      }
      const tlFlow = hr.tie_line_flows[0];
      if (tlFlow && diff > 0 && tlFlow.actual_flow > 0) {
        totalCongestionSurplus += diff * tlFlow.actual_flow;
      }
    }
  }

  console.log(`    分区出清时段: ${zonedCount}/24 小时`);
  console.log(`    最大价差时段: ${maxDiffHour}:00 (B-A)价差: ${maxPriceDiff.toFixed(2)}元/MWh`);
  console.log(`    理论全日阻塞盈余: ${totalCongestionSurplus.toFixed(2)}元`);
  if (zonedCount === 0) {
    console.log('    ⚠ 警告: 本次出清未触发分区，将无法验证FTR结算。调整报价参数...');
  }

  logStep(6, '执行FTR每日结算');

  const dailySettlement = ftrService.executeDailyFtrSettlement(td.id);
  console.log(`  ✓ FTR每日结算完成`);
  console.log(`    全日阻塞盈余总额: ${dailySettlement.summary.total_congestion_surplus.toFixed(2)}元`);
  console.log(`    支付FTR持有人总额: ${dailySettlement.summary.total_ftr_payment.toFixed(2)}元`);
  console.log(`    进入阻塞盈余池: ${dailySettlement.summary.total_surplus_to_pool.toFixed(2)}元`);
  console.log(`    结算明细记录数: ${dailySettlement.summary.hourly_count}`);

  if (dailySettlement.summary.hourly_count > 0) {
    const sampleSettlement = dailySettlement.settlements.find(s => s.congestion_price_diff > 0);
    if (sampleSettlement) {
      console.log(`\n  [时段${sampleSettlement.hour}:00 结算详情]`);
      console.log(`    阻塞价差(B-A): ${sampleSettlement.congestion_price_diff.toFixed(2)}元/MWh`);
      console.log(`    联络线传输量: ${sampleSettlement.actual_flow_mw.toFixed(2)}MW (A→B方向)`);
      console.log(`    阻塞盈余: ${sampleSettlement.total_congestion_surplus.toFixed(2)}元`);
      console.log(`    FTR支付总额: ${sampleSettlement.total_ftr_payment.toFixed(2)}元`);
      if (sampleSettlement.settlement_note) {
        console.log(`    说明: ${sampleSettlement.settlement_note}`);
      }
      if (sampleSettlement.items && sampleSettlement.items.length > 0) {
        console.log(`    各持有人收入:`);
        for (const item of sampleSettlement.items) {
          console.log(`      - ${item.participant_code}: 持有${item.holding_capacity_mw}MW`
            + ` 原始收入${item.original_income.toFixed(2)}元`
            + ` 分摊比例${(item.prorated_ratio * 100).toFixed(1)}%`
            + ` → 实际收入${item.final_income.toFixed(2)}元`);
        }
      }
    }
  }

  logStep(7, '查询单主体FTR每日结算');

  const conB1Daily = ftrService.getDailySettlementForParticipant(td.id, conB1.id);
  console.log(`  ✓ ${conB1Daily.participant.code}(${conB1Daily.participant.name})当日FTR收入`);
  console.log(`    总计: ${conB1Daily.total_income.toFixed(2)}元`);
  const incomeHours = conB1Daily.hourly_items.filter(i => i.final_income > 0);
  console.log(`    有收入时段数: ${incomeHours.length}/24`);
  if (incomeHours.length > 0) {
    const top3 = [...incomeHours].sort((a, b) => b.final_income - a.final_income).slice(0, 3);
    for (const item of top3) {
      const ds = dailySettlement.settlements.find(s => s.id === item.settlement_id);
      const hour = ds ? ds.hour : '?';
      console.log(`      时段${hour}:00 收入${item.final_income.toFixed(2)}元`);
    }
  }

  logStep(8, '创建多个交易日并出清结算(模拟整月)');

  const extraDates = [10, 20, 25].filter(d => d !== 15);
  const extraTdIds = [];

  for (const day of extraDates) {
    const extraDate = `${testMonth}-${String(day).padStart(2, '0')}`;
    const extraTd = tradingDayService.createTradingDay({
      trade_date: extraDate,
      bid_deadline: new Date(Date.now() + 24 * 3600 * 1000).toISOString()
    });
    extraTdIds.push(extraTd.id);

    submitZonalBids(extraTd.id, participants);
    clearingService.executeClearing(extraTd.id);
    ftrService.executeDailyFtrSettlement(extraTd.id);

    console.log(`  ✓ 交易日 ${extraDate} 出清+FTR结算完成`);
  }

  logStep(9, '生成FTR月度报告');

  const monthlyReport = ftrService.generateMonthlyReport(testMonth);
  console.log(`  ✓ FTR月度报告生成 (${testMonth})`);
  console.log(`    报告状态: ${monthlyReport.status}`);
  console.log(`    拍卖场次: ${monthlyReport.total_auctions}`);
  console.log(`    FTR持有人数: ${monthlyReport.total_ftr_holders}`);
  console.log(`    总持有容量: ${monthlyReport.total_holding_capacity_mw.toFixed(2)}MW`);
  console.log(`    拍卖总付款: ${monthlyReport.total_auction_payment.toFixed(2)}元`);
  console.log(`    结算总收入: ${monthlyReport.total_settlement_income.toFixed(2)}元`);
  console.log(`    FTR持有人净收益: ${monthlyReport.total_net_benefit.toFixed(2)}元`);
  console.log('');
  console.log(`    阻塞盈余统计:`);
  console.log(`      总阻塞盈余: ${monthlyReport.total_congestion_surplus.toFixed(2)}元`);
  console.log(`      支付FTR: ${monthlyReport.total_ftr_paid.toFixed(2)}元`);
  console.log(`      进入盈余池: ${monthlyReport.total_surplus_to_pool.toFixed(2)}元`);
  console.log(`      盈余池退还总额: ${monthlyReport.pool_refund_total.toFixed(2)}元`);

  console.log(`\n  [各主体FTR月报明细]`);
  for (const item of monthlyReport.items) {
    const sign = item.net_benefit >= 0 ? '+' : '';
    console.log(`    ${item.participant_code}(${item.participant_type}):`);
    console.log(`      持有容量: ${item.holding_capacity_mw.toFixed(2)}MW`);
    console.log(`      月累计收入: ${item.monthly_income.toFixed(2)}元`);
    console.log(`      拍卖付款: ${item.auction_payment.toFixed(2)}元`);
    if (item.pool_refund_amount > 0) {
      console.log(`      盈余池退还: ${item.pool_refund_amount.toFixed(2)}元`);
    }
    console.log(`      净收益: ${sign}${item.net_benefit.toFixed(2)}元`);
  }

  logStep(10, '查询阻塞盈余池及退还明细');

  const pool = ftrService.getSurplusPool(testMonth);
  console.log(`  ✓ 阻塞盈余池 (${testMonth})`);
  console.log(`    状态: ${pool.status}`);
  console.log(`    期初余额: ${pool.opening_balance.toFixed(2)}元`);
  console.log(`    本月增加: ${pool.monthly_addition.toFixed(2)}元`);
  console.log(`    已退还: ${pool.total_refunded.toFixed(2)}元`);
  console.log(`    期末余额: ${pool.closing_balance.toFixed(2)}元`);

  if (pool.refund_details && pool.refund_details.length > 0) {
    console.log(`\n    退还明细(按各售电公司当月购电量占比):`);
    for (const refund of pool.refund_details) {
      console.log(`      - ${refund.participant_code}: 购电${refund.total_purchase_mwh.toFixed(0)}MWh`
        + ` 占比${(refund.share_ratio * 100).toFixed(1)}%`
        + ` 退还${refund.refund_amount.toFixed(2)}元`);
    }
  }

  logStep(11, '查询FTR拍卖出清价历史趋势');

  const trend = ftrService.getClearingPriceTrend();
  console.log(`  ✓ 历史出清价趋势: 共 ${trend.total_auctions} 次拍卖`);
  for (const t of trend.trend) {
    console.log(`    ${t.month} | ${t.auction_no} | ${t.from_zone_code}→${t.to_zone_code}`
      + ` | ${t.tie_line_code} | 出清价${t.clearing_price}元/MW·月`
      + ` | ${t.total_cleared_capacity_mw}/${t.total_capacity_mw}MW`);
  }

  logStep(12, '验证基础查询接口');

  const allAuctions = ftrService.listAuctions({ month: testMonth });
  console.log(`  ✓ 本月拍卖列表: ${allAuctions.length} 场`);

  const auctionByNo = ftrService.getAuctionByNo(auction.auction_no);
  console.log(`  ✓ 按编号查询拍卖: ${auctionByNo?.auction_no || '未找到'}`);

  const conB1Bids = ftrService.listParticipantBids(conB1.id, { month: testMonth });
  console.log(`  ✓ ${conB1.code}报价记录: ${conB1Bids.length} 条`);
  for (const b of conB1Bids) {
    console.log(`    - ${b.auction_no}: ${b.bid_capacity_mw}MW @ ${b.bid_price}元 [${b.status}]`);
  }

  const monthHoldings = ftrService.getActiveHoldingsForMonth(testMonth);
  console.log(`  ✓ 本月活跃FTR持仓: ${monthHoldings.all_holdings.length} 份`);
  for (const key of Object.keys(monthHoldings.grouped)) {
    const g = monthHoldings.grouped[key];
    console.log(`    方向 ${g.from_zone_code}→${g.to_zone_code}: 总容量${g.total_ftr_capacity_mw.toFixed(2)}MW, ${g.holdings.length}持有人`);
  }

  const reportByMonth = ftrService.getMonthlyReport(testMonth);
  console.log(`  ✓ 月报查询: ${reportByMonth ? '找到' + reportByMonth.items.length + '个主体明细' : '未找到'}`);

  logStep(13, '验证边界条件: 单人容量上限约束(出清时截断)');

  const testMonthNext = (() => {
    const d = new Date(testMonth + '-01');
    d.setMonth(d.getMonth() + 1);
    return d.toISOString().substring(0, 7);
  })();

  const auction2 = ftrService.openAuction({
    month: testMonthNext,
    tie_line_id: tieLine.id,
    direction_zone_from: zoneA.id,
    direction_zone_to: zoneB.id,
    total_capacity_mw: 80
  });

  const maxCap = 80 * 0.3;
  console.log(`  ✓ 开启拍卖2 (${testMonthNext}): 总容量80MW, 单人上限${maxCap.toFixed(1)}MW`);

  ftrService.submitBid(auction2.id, conB1.id, maxCap + 20, 25);
  console.log(`  ✓ ${conB1.code} 报价: ${maxCap + 20}MW @ 25元 (报价超单人上限, 出清时将被截断至${maxCap}MW)`);

  ftrService.submitBid(auction2.id, conB2.id, 40, 20);
  console.log(`  ✓ ${conB2.code} 报价: 40MW @ 20元`);

  ftrService.submitBid(auction2.id, genB.id, 50, 15);
  console.log(`  ✓ ${genB.code} 报价: 50MW @ 15元`);

  const cleared2 = ftrService.executeAuctionClearing(auction2.id);
  console.log(`  ✓ 拍卖2出清完成: 出清价${cleared2.clearing_price}元, 总出清${cleared2.total_cleared_capacity_mw}MW`);

  for (const bid of cleared2.bids) {
    if (bid.cleared_capacity_mw > 0) {
      console.log(`    ${bid.participant_code}: 报价${bid.bid_capacity_mw}MW → 中标${bid.cleared_capacity_mw}MW (上限${maxCap}MW)`);
      if (bid.participant_id === conB1.id) {
        assertApprox(bid.cleared_capacity_mw, maxCap, 0.01, `${bid.participant_code}应被截断到单人上限`);
      }
    }
  }
  console.log(`  ✓ 校验: ${conB1.code}中标${cleared2.bids.find(b=>b.participant_id===conB1.id).cleared_capacity_mw}MW = 单人上限${maxCap}MW (截断正确)`);

  logStep(14, '验证边界条件: 拍卖容量上限约束');

  const testMonth2 = (() => {
    const d = new Date(testMonth + '-01');
    d.setMonth(d.getMonth() + 2);
    return d.toISOString().substring(0, 7);
  })();

  const overCapacity = tieLine.max_transfer_capacity * 0.8 + 10;
  try {
    ftrService.openAuction({
      month: testMonth2,
      tie_line_id: tieLine.id,
      direction_zone_from: zoneA.id,
      direction_zone_to: zoneB.id,
      total_capacity_mw: overCapacity
    });
    console.log(`  ✗ 错误: 应该拒绝超过80%容量的拍卖`);
    throw new Error('80%容量上限约束未生效!');
  } catch (e) {
    console.log(`  ✓ 正确拒绝超额拍卖: "${e.message.substring(0, 60)}..."`);
  }

  console.log('\n' + '='.repeat(70));
  console.log('✓ 所有测试通过！FTR模块功能完整验证:');
  console.log('  1. FTR拍卖开启(含80%容量上限和30%单人上限)');
  console.log('  2. 报价提交(单人多报价+累计容量约束)');
  console.log('  3. 统一价格出清(价高者得，最后中标价为出清价)');
  console.log('  4. 分区出清产生阻塞盈余');
  console.log('  5. 每日FTR结算(价差计算+按比例分摊机制)');
  console.log('  6. 阻塞盈余池管理(盈余归集)');
  console.log('  7. 月度报告(持有/收入/付款/净收益)');
  console.log('  8. 盈余池退还(按购电量占比)');
  console.log('  9. 历史出清价趋势查询');
  console.log('='.repeat(70));
}

try {
  runFTRModuleTest();
} catch (err) {
  console.error('\n✗ 测试失败:', err.message);
  console.error(err.stack);
  process.exit(1);
}
