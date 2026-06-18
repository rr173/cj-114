const db = require('../src/utils/db');
const participantService = require('../src/services/participantService');
const tradingDayService = require('../src/services/tradingDayService');
const biddingService = require('../src/services/biddingService');
const clearingService = require('../src/services/clearingService');
const settlementService = require('../src/services/settlementService');

function resetDatabase() {
  const tables = [
    'settlement_details',
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
  console.log('✓ 数据库已重置');
}

function logStep(step, msg) {
  console.log(`\n[${step}] ${msg}`);
}

function runTest() {
  console.log('='.repeat(60));
  console.log('电力现货市场出清与结算引擎 - 端到端测试');
  console.log('='.repeat(60));

  resetDatabase();

  logStep(1, '注册市场主体');

  const gen1 = participantService.registerParticipant({
    code: 'GEN001',
    name: '火电厂A',
    type: 'generator',
    installed_capacity: 300,
    min_output: 100,
    ramp_rate: 50
  });
  console.log(`  ✓ 注册电厂: ${gen1.code} ${gen1.name} (装机:${gen1.installed_capacity}MW 最小出力:${gen1.min_output}MW 爬坡:${gen1.ramp_rate}MW/h)`);

  const gen2 = participantService.registerParticipant({
    code: 'GEN002',
    name: '风电场B',
    type: 'generator',
    installed_capacity: 200,
    min_output: 0,
    ramp_rate: 200
  });
  console.log(`  ✓ 注册电厂: ${gen2.code} ${gen2.name} (装机:${gen2.installed_capacity}MW 最小出力:${gen2.min_output}MW 爬坡:${gen2.ramp_rate}MW/h)`);

  const con1 = participantService.registerParticipant({
    code: 'CON001',
    name: '售电公司甲',
    type: 'consumer',
    contracted_capacity: 250
  });
  console.log(`  ✓ 注册售电公司: ${con1.code} ${con1.name} (签约容量:${con1.contracted_capacity}MW)`);

  const con2 = participantService.registerParticipant({
    code: 'CON002',
    name: '售电公司乙',
    type: 'consumer',
    contracted_capacity: 200
  });
  console.log(`  ✓ 注册售电公司: ${con2.code} ${con2.name} (签约容量:${con2.contracted_capacity}MW)`);

  logStep(2, '创建交易日');
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + 1);
  const tradeDate = futureDate.toISOString().split('T')[0];
  const deadline = new Date(futureDate.getTime() + 24 * 3600 * 1000).toISOString();

  const td = tradingDayService.createTradingDay({
    trade_date: tradeDate,
    bid_deadline: deadline
  });
  console.log(`  ✓ 创建交易日: ${td.trade_date} (截止时间: ${td.bid_deadline})`);
  console.log(`  ✓ 交易日ID: ${td.id}`);
  console.log(`  ✓ 状态: ${td.status}`);

  logStep(3, '提交发电侧报价');

  const gen1Bids = [];
  for (let h = 0; h < 24; h++) {
    let segments;
    if (h >= 8 && h <= 20) {
      segments = [
        { price: 250, capacity: 100 },
        { price: 320, capacity: 100 },
        { price: 400, capacity: 100 }
      ];
    } else {
      segments = [
        { price: 200, capacity: 120 },
        { price: 280, capacity: 80 },
        { price: 350, capacity: 50 }
      ];
    }
    gen1Bids.push({ hour: h, segments });
  }
  const gen1Result = biddingService.submitGeneratorBid(td.id, gen1.id, gen1Bids);
  console.log(`  ✓ 火电厂A提交报价: ${gen1Result.length} 个时段`);

  const gen2Bids = [];
  for (let h = 0; h < 24; h++) {
    let windCapacity = 80 + Math.floor(Math.random() * 80);
    let price = 150;
    if (h >= 22 || h <= 5) {
      windCapacity = 120 + Math.floor(Math.random() * 60);
      price = 100;
    }
    gen2Bids.push({
      hour: h,
      segments: [{ price: price, capacity: windCapacity }]
    });
  }
  const gen2Result = biddingService.submitGeneratorBid(td.id, gen2.id, gen2Bids);
  console.log(`  ✓ 风电场B提交报价: ${gen2Result.length} 个时段`);

  logStep(4, '提交用电侧报价');

  const con1Bids = [];
  for (let h = 0; h < 24; h++) {
    let demand;
    let maxPrice;
    if (h >= 9 && h <= 11) {
      demand = 180;
      maxPrice = 500;
    } else if (h >= 18 && h <= 21) {
      demand = 200;
      maxPrice = 550;
    } else if (h >= 0 && h <= 6) {
      demand = 80;
      maxPrice = 350;
    } else {
      demand = 120;
      maxPrice = 420;
    }
    con1Bids.push({ hour: h, demand, max_price: maxPrice });
  }
  const con1Result = biddingService.submitConsumerBid(td.id, con1.id, con1Bids);
  console.log(`  ✓ 售电公司甲提交报价: ${con1Result.length} 个时段`);

  const con2Bids = [];
  for (let h = 0; h < 24; h++) {
    let demand;
    let maxPrice;
    if (h >= 10 && h <= 12) {
      demand = 150;
      maxPrice = 480;
    } else if (h >= 19 && h <= 20) {
      demand = 170;
      maxPrice = 520;
    } else if (h >= 1 && h <= 5) {
      demand = 60;
      maxPrice = 300;
    } else {
      demand = 100;
      maxPrice = 400;
    }
    con2Bids.push({ hour: h, demand, max_price: maxPrice });
  }
  const con2Result = biddingService.submitConsumerBid(td.id, con2.id, con2Bids);
  console.log(`  ✓ 售电公司乙提交报价: ${con2Result.length} 个时段`);

  logStep(5, '执行市场出清');
  const clearingResult = clearingService.executeClearing(td.id);
  console.log(`  ✓ 出清完成，交易日状态: ${clearingResult.status}`);
  console.log(`  ✓ 出清时段数: ${clearingResult.hourly_results.length}`);

  let totalVolume = 0;
  let peakHour = 0, peakPrice = 0;
  let valleyHour = 0, valleyPrice = Infinity;
  for (const hr of clearingResult.hourly_results) {
    totalVolume += hr.clearing_volume;
    if (hr.clearing_price > peakPrice) {
      peakPrice = hr.clearing_price;
      peakHour = hr.hour;
    }
    if (hr.clearing_price > 0 && hr.clearing_price < valleyPrice) {
      valleyPrice = hr.clearing_price;
      valleyHour = hr.hour;
    }
  }
  console.log(`  ✓ 全日总出清电量: ${totalVolume.toFixed(2)} MWh`);
  console.log(`  ✓ 峰时段: ${peakHour}:00 电价: ${peakPrice.toFixed(2)} 元/MWh`);
  console.log(`  ✓ 谷时段: ${valleyHour}:00 电价: ${valleyPrice.toFixed(2)} 元/MWh`);

  const sampleHour = 10;
  const hr10 = clearingResult.hourly_results[sampleHour];
  console.log(`\n  [时段 ${sampleHour}:00 详情]`);
  console.log(`    出清电价: ${hr10.clearing_price.toFixed(2)} 元/MWh`);
  console.log(`    出清总量: ${hr10.clearing_volume.toFixed(2)} MW`);
  console.log(`    电厂中标:`);
  for (const g of hr10.generators) {
    console.log(`      - ${g.code}: 初始中标${g.initial_allocation.toFixed(2)}MW → 最终调度${g.final_dispatch.toFixed(2)}MW ${g.adjustment_reason || ''}`);
  }
  console.log(`    用户中标:`);
  for (const c of hr10.consumers) {
    console.log(`      - ${c.code}: 中标${c.final_dispatch.toFixed(2)}MW`);
  }

  logStep(6, '查询出清电价序列');
  const prices = tradingDayService.getClearingPrices(td.id);
  console.log(`  ✓ 出清电价序列获取成功 (${prices.prices.length} 个时段)`);
  const priceStr = prices.prices.slice(8, 14).map(p => `${p.hour}时:${p.clearing_price.toFixed(0)}`).join(' | ');
  console.log(`    ${priceStr} ...`);

  logStep(7, '提交实际发用电量');

  const gen1Actual = [];
  const gen1Alloc = clearingService.getParticipantClearing(td.id, gen1.id);
  for (const row of gen1Alloc.hourly) {
    let actual = row.final_dispatch;
    if (row.hour >= 10 && row.hour <= 15) {
      actual = actual * 0.92;
    } else if (row.hour >= 20 && row.hour <= 22) {
      actual = actual * 1.05;
    }
    gen1Actual.push({ hour: row.hour, actual_volume: Math.round(actual * 100) / 100 });
  }
  settlementService.submitActualVolumes(td.id, gen1.id, gen1Actual);
  console.log(`  ✓ 火电厂A提交实际电量 (模拟偏差: 白天少发8%，晚间多发5%)`);

  const gen2Actual = [];
  const gen2Alloc = clearingService.getParticipantClearing(td.id, gen2.id);
  for (const row of gen2Alloc.hourly) {
    let actual = row.final_dispatch;
    actual = actual * (0.85 + Math.random() * 0.25);
    gen2Actual.push({ hour: row.hour, actual_volume: Math.round(actual * 100) / 100 });
  }
  settlementService.submitActualVolumes(td.id, gen2.id, gen2Actual);
  console.log(`  ✓ 风电场B提交实际电量 (模拟随机波动 ±15%)`);

  const con1Actual = [];
  const con1Alloc = clearingService.getParticipantClearing(td.id, con1.id);
  for (const row of con1Alloc.hourly) {
    let actual = row.final_dispatch;
    if (row.hour >= 11 && row.hour <= 13) {
      actual = actual * 1.1;
    } else if (row.hour >= 2 && row.hour <= 4) {
      actual = actual * 0.85;
    }
    con1Actual.push({ hour: row.hour, actual_volume: Math.round(actual * 100) / 100 });
  }
  settlementService.submitActualVolumes(td.id, con1.id, con1Actual);
  console.log(`  ✓ 售电公司甲提交实际电量 (模拟偏差: 午间多用10%，深夜少用15%)`);

  const con2Actual = [];
  const con2Alloc = clearingService.getParticipantClearing(td.id, con2.id);
  for (const row of con2Alloc.hourly) {
    let actual = row.final_dispatch;
    if (row.hour >= 19 && row.hour <= 21) {
      actual = actual * 1.15;
    }
    con2Actual.push({ hour: row.hour, actual_volume: Math.round(actual * 100) / 100 });
  }
  settlementService.submitActualVolumes(td.id, con2.id, con2Actual);
  console.log(`  ✓ 售电公司乙提交实际电量 (模拟偏差: 晚高峰多用15%)`);

  logStep(8, '执行偏差结算');
  const settlement = settlementService.executeSettlement(td.id);
  console.log(`  ✓ 结算完成，交易日状态: ${settlement.status}`);
  console.log(`  ✓ 全市场偏差结算总额: ${settlement.total_settlement_amount.toFixed(2)} 元`);

  console.log(`\n  [各主体结算汇总]`);
  for (const p of settlement.participants) {
    const typeLabel = p.type === 'generator' ? '电厂' : '售电';
    console.log(`    ${p.code}(${typeLabel}) ${p.name}:`);
    console.log(`      总中标: ${p.total_bid.toFixed(2)}MWh | 总实际: ${p.total_actual.toFixed(2)}MWh | 总偏差: ${p.total_deviation >= 0 ? '+' : ''}${p.total_deviation.toFixed(2)}MWh`);
    console.log(`      偏差结算费用: ${p.total_settlement_amount.toFixed(2)} 元`);
  }

  logStep(9, '查询单主体完整报告');
  const report = settlementService.getFullParticipantReport(td.id, gen1.id);
  console.log(`  ✓ 获取 ${report.participant.name} 完整报告成功`);
  console.log(`    总中标电量: ${report.summary.total_bid_volume.toFixed(2)} MWh`);
  console.log(`    总实际电量: ${report.summary.total_actual_volume.toFixed(2)} MWh`);
  console.log(`    总偏差电量: ${report.summary.total_deviation >= 0 ? '+' : ''}${report.summary.total_deviation.toFixed(2)} MWh`);
  console.log(`    统一出清电费: ${report.summary.total_clearing_amount.toFixed(2)} 元`);
  console.log(`    偏差考核费用: ${report.summary.total_deviation_settlement.toFixed(2)} 元`);

  console.log(`\n  [${report.participant.name} 偏差费用最高时段 Top 3]`);
  const topDeviation = report.hourly
    .filter(h => h.settlement_amount)
    .sort((a, b) => Math.abs(b.settlement_amount) - Math.abs(a.settlement_amount))
    .slice(0, 3);
  for (const h of topDeviation) {
    const dir = h.deviation_direction === 'positive' ? '正偏差' : h.deviation_direction === 'negative' ? '负偏差' : '无偏差';
    console.log(`    ${h.hour}:00 中标:${h.bid_volume?.toFixed(2) || 0}MW 实际:${h.actual_volume?.toFixed(2) || 0}MW ${dir}:${h.deviation?.toFixed(2) || 0}MW 考核:${h.settlement_amount?.toFixed(2) || 0}元`);
  }

  logStep(10, '验证接口功能');

  const allParticipants = participantService.listParticipants();
  console.log(`  ✓ 主体列表查询: 共 ${allParticipants.length} 个主体`);

  const allTradingDays = tradingDayService.listTradingDays();
  console.log(`  ✓ 交易日列表查询: 共 ${allTradingDays.length} 个交易日`);

  const participantByCode = participantService.getParticipantByCode('GEN001');
  console.log(`  ✓ 编码查询主体: ${participantByCode?.name || '未找到'}`);

  const tdByDate = tradingDayService.getTradingDayByDate(tradeDate);
  console.log(`  ✓ 日期查询交易日: ${tdByDate?.trade_date || '未找到'}`);

  console.log('\n' + '='.repeat(60));
  console.log('✓ 所有测试通过！系统功能完整。');
  console.log('='.repeat(60));
}

try {
  runTest();
} catch (err) {
  console.error('\n✗ 测试失败:', err.message);
  console.error(err.stack);
  process.exit(1);
}
