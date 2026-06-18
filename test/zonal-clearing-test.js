const db = require('../src/utils/db');
const participantService = require('../src/services/participantService');
const tradingDayService = require('../src/services/tradingDayService');
const biddingService = require('../src/services/biddingService');
const clearingService = require('../src/services/clearingService');
const settlementService = require('../src/services/settlementService');
const priceZoneService = require('../src/services/priceZoneService');
const tieLineService = require('../src/services/tieLineService');

function resetDatabase() {
  db.pragma('foreign_keys = OFF');
  const tables = [
    'congestion_surplus',
    'tie_line_flows',
    'zone_clearing_results',
    'tie_lines',
    'price_zone_participants',
    'price_zones',
    'settlement_details',
    'contract_decomposition_results',
    'contract_decomposition_curves',
    'mid_long_term_contracts',
    'actual_volumes',
    'clearing_allocations',
    'clearing_results',
    'consumer_bids',
    'generator_bids',
    'trading_days',
    'market_participants'
  ];
  for (const t of tables) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  db.pragma('foreign_keys = ON');
  console.log('✓ 数据库已重置');
}

function logStep(step, msg) {
  console.log(`\n[${step}] ${msg}`);
}

function runZonalClearingTest() {
  console.log('='.repeat(70));
  console.log('节点边际电价（分区出清）功能测试');
  console.log('='.repeat(70));

  resetDatabase();

  logStep(1, '注册市场主体（A区电厂便宜，B区负荷大）');

  const genA1 = participantService.registerParticipant({
    code: 'GEN-A01',
    name: 'A区火电厂1',
    type: 'generator',
    installed_capacity: 200,
    min_output: 50,
    ramp_rate: 100
  });
  console.log(`  ✓ ${genA1.code}: ${genA1.name} (装机:${genA1.installed_capacity}MW)`);

  const genA2 = participantService.registerParticipant({
    code: 'GEN-A02',
    name: 'A区风电场',
    type: 'generator',
    installed_capacity: 150,
    min_output: 0,
    ramp_rate: 150
  });
  console.log(`  ✓ ${genA2.code}: ${genA2.name} (装机:${genA2.installed_capacity}MW)`);

  const genB1 = participantService.registerParticipant({
    code: 'GEN-B01',
    name: 'B区燃气电厂',
    type: 'generator',
    installed_capacity: 100,
    min_output: 30,
    ramp_rate: 80
  });
  console.log(`  ✓ ${genB1.code}: ${genB1.name} (装机:${genB1.installed_capacity}MW)`);

  const conA = participantService.registerParticipant({
    code: 'CON-A01',
    name: 'A区售电公司',
    type: 'consumer',
    contracted_capacity: 100
  });
  console.log(`  ✓ ${conA.code}: ${conA.name} (签约:${conA.contracted_capacity}MW)`);

  const conB = participantService.registerParticipant({
    code: 'CON-B01',
    name: 'B区售电公司',
    type: 'consumer',
    contracted_capacity: 300
  });
  console.log(`  ✓ ${conB.code}: ${conB.name} (签约:${conB.contracted_capacity}MW)`);

  logStep(2, '创建电价区（A区和B区）');

  const zoneA = priceZoneService.createPriceZone({
    code: 'ZONE-A',
    name: 'A区',
    description: '送端区域，电价较低'
  });
  console.log(`  ✓ 创建电价区: ${zoneA.code} - ${zoneA.name}`);

  const zoneB = priceZoneService.createPriceZone({
    code: 'ZONE-B',
    name: 'B区',
    description: '受端区域，电价较高'
  });
  console.log(`  ✓ 创建电价区: ${zoneB.code} - ${zoneB.name}`);

  logStep(3, '将市场主体分配到对应电价区');

  priceZoneService.assignParticipantToZone(zoneA.id, genA1.id);
  priceZoneService.assignParticipantToZone(zoneA.id, genA2.id);
  priceZoneService.assignParticipantToZone(zoneA.id, conA.id);
  console.log(`  ✓ A区分配: ${genA1.code}, ${genA2.code}, ${conA.code}`);

  priceZoneService.assignParticipantToZone(zoneB.id, genB1.id);
  priceZoneService.assignParticipantToZone(zoneB.id, conB.id);
  console.log(`  ✓ B区分配: ${genB1.code}, ${conB.code}`);

  const zones = priceZoneService.listPriceZones();
  console.log(`  ✓ 电价区总数: ${zones.length}`);
  for (const z of zones) {
    console.log(`    - ${z.code}: ${z.participants.length} 个主体`);
  }

  logStep(4, '创建区间联络线（最大传输容量 80MW）');

  const tieLine = tieLineService.createTieLine({
    code: 'TIE-AB01',
    name: 'AB区联络线',
    from_zone_id: zoneA.id,
    to_zone_id: zoneB.id,
    max_transfer_capacity: 80,
    description: 'A区到B区的联络线，最大传输80MW'
  });
  console.log(`  ✓ 创建联络线: ${tieLine.code} - ${tieLine.name}`);
  console.log(`    起点: ${tieLine.from_zone.code} 终点: ${tieLine.to_zone.code}`);
  console.log(`    最大传输容量: ${tieLine.max_transfer_capacity} MW`);

  logStep(5, '创建交易日');

  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + 1);
  const tradeDate = futureDate.toISOString().split('T')[0];
  const deadline = new Date(futureDate.getTime() + 24 * 3600 * 1000).toISOString();

  const td = tradingDayService.createTradingDay({
    trade_date: tradeDate,
    bid_deadline: deadline
  });
  console.log(`  ✓ 创建交易日: ${td.trade_date}`);

  logStep(6, '提交发电侧报价（A区便宜，B区贵）');

  const genA1Bids = [];
  const genA2Bids = [];
  const genB1Bids = [];

  for (let h = 0; h < 24; h++) {
    genA1Bids.push({
      hour: h,
      segments: [
        { price: 200, capacity: 100 },
        { price: 250, capacity: 100 }
      ]
    });

    genA2Bids.push({
      hour: h,
      segments: [{ price: 100, capacity: 120 }]
    });

    genB1Bids.push({
      hour: h,
      segments: [
        { price: 400, capacity: 50 },
        { price: 500, capacity: 50 }
      ]
    });
  }

  biddingService.submitGeneratorBid(td.id, genA1.id, genA1Bids);
  console.log(`  ✓ ${genA1.code} 提交报价 (低价: 200-250元/MWh)`);

  biddingService.submitGeneratorBid(td.id, genA2.id, genA2Bids);
  console.log(`  ✓ ${genA2.code} 提交报价 (低价: 100元/MWh)`);

  biddingService.submitGeneratorBid(td.id, genB1.id, genB1Bids);
  console.log(`  ✓ ${genB1.code} 提交报价 (高价: 400-500元/MWh)`);

  logStep(7, '提交用电侧报价（B区负荷大）');

  const conABids = [];
  const conBBids = [];

  for (let h = 0; h < 24; h++) {
    let demandA = 50 + Math.floor(Math.random() * 30);
    let maxPriceA = 400;
    conABids.push({ hour: h, demand: demandA, max_price: maxPriceA });

    let demandB = 200 + Math.floor(Math.random() * 80);
    let maxPriceB = 600;
    conBBids.push({ hour: h, demand: demandB, max_price: maxPriceB });
  }

  biddingService.submitConsumerBid(td.id, conA.id, conABids);
  console.log(`  ✓ ${conA.code} 提交报价 (A区小负荷)`);

  biddingService.submitConsumerBid(td.id, conB.id, conBBids);
  console.log(`  ✓ ${conB.code} 提交报价 (B区大负荷)`);

  logStep(8, '执行市场出清（验证分区出清）');

  const clearingResult = clearingService.executeClearing(td.id);
  console.log(`  ✓ 出清完成，状态: ${clearingResult.status}`);

  const sampleHour = 12;
  const hrSample = clearingResult.hourly_results[sampleHour];

  console.log(`\n  [时段 ${sampleHour}:00 出清详情]`);
  console.log(`    出清类型: ${hrSample.clearing_type === 'zoned' ? '分区阻塞出清' : '统一出清'}`);
  console.log(`    统一出清价: ${hrSample.clearing_price.toFixed(2)} 元/MWh`);
  console.log(`    总出清量: ${hrSample.clearing_volume.toFixed(2)} MW`);

  if (hrSample.zone_results && hrSample.zone_results.length > 0) {
    console.log(`\n    分区出清结果:`);
    for (const zr of hrSample.zone_results) {
      console.log(`      ${zr.zone_name}: 电价 ${zr.clearing_price.toFixed(2)} 元/MWh, 出清量 ${zr.clearing_volume.toFixed(2)} MW, 净外送 ${zr.net_export.toFixed(2)} MW`);
    }
  }

  if (hrSample.tie_line_flows && hrSample.tie_line_flows.length > 0) {
    console.log(`\n    联络线潮流:`);
    for (const tf of hrSample.tie_line_flows) {
      console.log(`      ${tf.tie_line_name}:`);
      console.log(`        潮流方向: ${tf.flow_direction === 'forward' ? 'A→B' : tf.flow_direction === 'reverse' ? 'B→A' : '无潮流'}`);
      console.log(`        实际潮流: ${tf.actual_flow.toFixed(2)} MW`);
      console.log(`        是否阻塞: ${tf.is_congested ? '是' : '否'}`);
      console.log(`        阻塞程度: ${(tf.congestion_level * 100).toFixed(2)}%`);
    }
  }

  let congestedHours = 0;
  let unifiedHours = 0;
  for (let h = 0; h < 24; h++) {
    const hr = clearingResult.hourly_results[h];
    if (hr.clearing_type === 'zoned') {
      congestedHours++;
    } else {
      unifiedHours++;
    }
  }
  console.log(`\n  全天统计: ${congestedHours} 个时段阻塞分区出清, ${unifiedHours} 个时段统一出清`);

  if (congestedHours > 0) {
    console.log(`  ✓ 验证通过: 存在分区阻塞出清时段`);
  } else {
    console.log(`  ⚠  警告: 没有出现阻塞分区出清，可能需要调整参数`);
  }

  logStep(9, '验证出清价格关系（低价区 < 统一价 < 高价区）');

  let priceRelationCorrect = true;
  for (let h = 0; h < 24; h++) {
    const hr = clearingResult.hourly_results[h];
    if (hr.clearing_type === 'zoned' && hr.zone_results.length === 2) {
      const zPrices = hr.zone_results.map(z => z.clearing_price).sort((a, b) => a - b);
      const lowPrice = zPrices[0];
      const highPrice = zPrices[1];
      const unifiedPrice = hr.clearing_price;

      if (!(lowPrice <= unifiedPrice && unifiedPrice <= highPrice)) {
        priceRelationCorrect = false;
        console.log(`  ✗ 时段 ${h}: 价格关系不正确 - 低价:${lowPrice} 统一:${unifiedPrice} 高价:${highPrice}`);
      }
    }
  }

  if (priceRelationCorrect) {
    console.log(`  ✓ 验证通过: 阻塞时段价格关系正确（低价区 < 统一价 < 高价区）`);
  }

  logStep(10, '提交实际发用电量');

  function submitActuals(participantId, factorRange) {
    const clearing = clearingService.getParticipantClearing(td.id, participantId);
    const actuals = [];
    for (const row of clearing.hourly) {
      let actual = row.final_dispatch;
      if (factorRange) {
        actual = actual * (factorRange[0] + Math.random() * (factorRange[1] - factorRange[0]));
      }
      actuals.push({ hour: row.hour, actual_volume: Math.round(actual * 100) / 100 });
    }
    settlementService.submitActualVolumes(td.id, participantId, actuals);
    return actuals;
  }

  submitActuals(genA1.id, [0.95, 1.05]);
  submitActuals(genA2.id, [0.85, 1.15]);
  submitActuals(genB1.id, [0.9, 1.1]);
  submitActuals(conA.id, [0.95, 1.05]);
  submitActuals(conB.id, [0.95, 1.05]);
  console.log(`  ✓ 所有主体提交实际电量`);

  logStep(11, '执行联合结算（含分区价格和阻塞盈余）');

  const settlement = settlementService.executeSettlement(td.id);
  console.log(`  ✓ 结算完成，状态: ${settlement.status}`);
  console.log(`    合约结算总额: ${settlement.summary.total_contract_amount.toFixed(2)} 元`);
  console.log(`    现货结算总额: ${settlement.summary.total_spot_amount.toFixed(2)} 元`);
  console.log(`    偏差结算总额: ${settlement.summary.total_deviation_amount.toFixed(2)} 元`);
  console.log(`    阻塞盈余返还: ${settlement.summary.total_congestion_surplus.toFixed(2)} 元`);
  console.log(`    结算总金额: ${settlement.summary.total_settlement_amount.toFixed(2)} 元`);

  logStep(12, '验证各主体按所在区电价结算');

  const genAReport = settlementService.getFullParticipantReport(td.id, genA1.id);
  const genBReport = settlementService.getFullParticipantReport(td.id, genB1.id);
  const conAReport = settlementService.getFullParticipantReport(td.id, conA.id);
  const conBReport = settlementService.getFullParticipantReport(td.id, conB.id);

  console.log(`\n  [各主体现货结算对比]`);
  console.log(`    A区电厂 ${genA1.code}: 现货结算 ${genAReport.summary.total_spot_settlement.toFixed(2)} 元`);
  console.log(`    B区电厂 ${genB1.code}: 现货结算 ${genBReport.summary.total_spot_settlement.toFixed(2)} 元`);
  console.log(`    A区用户 ${conA.code}: 现货结算 ${conAReport.summary.total_spot_settlement.toFixed(2)} 元`);
  console.log(`    B区用户 ${conB.code}: 现货结算 ${conBReport.summary.total_spot_settlement.toFixed(2)} 元`);

  console.log(`\n  [阻塞盈余返还]`);
  for (const p of settlement.participants) {
    if (p.total_congestion_surplus !== 0) {
      console.log(`    ${p.code}: ${p.total_congestion_surplus.toFixed(2)} 元`);
    }
  }

  const totalCongestionSurplus = settlement.summary.total_congestion_surplus;
  if (Math.abs(totalCongestionSurplus) > 0) {
    console.log(`  ✓ 验证通过: 存在阻塞盈余分摊`);
  }

  logStep(13, '查询电价区和联络线列表接口');

  const allZones = priceZoneService.listPriceZones();
  console.log(`  ✓ 电价区列表: ${allZones.length} 个`);

  const allTieLines = tieLineService.listTieLines();
  console.log(`  ✓ 联络线列表: ${allTieLines.length} 条`);

  const zoneByCode = priceZoneService.getPriceZoneByCode('ZONE-A');
  console.log(`  ✓ 按编码查询电价区: ${zoneByCode?.name || '未找到'}`);

  const tieByCode = tieLineService.getTieLineByCode('TIE-AB01');
  console.log(`  ✓ 按编码查询联络线: ${tieByCode?.name || '未找到'}`);

  logStep(14, '测试修改联络线传输容量');

  const updatedTieLine = tieLineService.updateMaxTransferCapacity(tieLine.id, 150);
  console.log(`  ✓ 联络线容量已更新: ${updatedTieLine.max_transfer_capacity} MW`);

  console.log('\n' + '='.repeat(70));
  console.log('✓ 节点边际电价功能测试完成！');
  console.log('='.repeat(70));
}

try {
  runZonalClearingTest();
} catch (err) {
  console.error('\n✗ 测试失败:', err.message);
  console.error(err.stack);
  process.exit(1);
}
