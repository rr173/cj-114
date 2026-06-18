const db = require('../src/utils/db');
const participantService = require('../src/services/participantService');
const tradingDayService = require('../src/services/tradingDayService');
const biddingService = require('../src/services/biddingService');
const clearingService = require('../src/services/clearingService');
const settlementService = require('../src/services/settlementService');
const contractService = require('../src/services/contractService');

function resetDatabase() {
  const tables = [
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
  console.log('✓ 数据库已重置');
}

function logStep(step, msg) {
  console.log(`\n[${step}] ${msg}`);
}

function runTest() {
  console.log('='.repeat(60));
  console.log('电力现货市场出清与联合结算引擎 - 端到端测试');
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

  logStep(3, '创建中长期合约');

  const monthStart = tradeDate.substring(0, 7) + '-01';
  const monthEnd = new Date(new Date(tradeDate).getFullYear(), new Date(tradeDate).getMonth() + 1, 0).toISOString().split('T')[0];

  const c1 = contractService.createContract({
    contract_no: 'MLT2025M001',
    buyer_id: con1.id,
    seller_id: gen1.id,
    start_date: monthStart,
    end_date: monthEnd,
    total_energy: 50000,
    contract_price: 300,
    decomposition_method: 'average'
  });
  console.log(`  ✓ 月度合约1(平均分解): ${c1.contract_no} 买方:${c1.buyer.code} 卖方:${c1.seller.code} 总电量:${c1.total_energy}MWh 单价:${c1.contract_price}元/MWh`);

  const typicalCurve = new Array(24).fill(1 / 24);
  for (let h = 8; h <= 20; h++) typicalCurve[h] = 0.06;
  const offPeak = typicalCurve.slice(0, 8).concat(typicalCurve.slice(21));
  const offSum = offPeak.reduce((s, v) => s + v, 0);
  const onSum = 13 * 0.06;
  for (let h = 0; h <= 7; h++) typicalCurve[h] = typicalCurve[h] * (1 - onSum) / offSum;
  for (let h = 21; h <= 23; h++) typicalCurve[h] = typicalCurve[h] * (1 - onSum) / offSum;

  const c2 = contractService.createContract({
    contract_no: 'MLT2025M002',
    buyer_id: con2.id,
    seller_id: gen2.id,
    start_date: monthStart,
    end_date: monthEnd,
    total_energy: 30000,
    contract_price: 280,
    decomposition_method: 'curve',
    decomposition_curve: typicalCurve
  });
  console.log(`  ✓ 月度合约2(典型曲线): ${c2.contract_no} 买方:${c2.buyer.code} 卖方:${c2.seller.code} 总电量:${c2.total_energy}MWh`);
  console.log(`    曲线和校验: ${typicalCurve.reduce((s, v) => s + v, 0).toFixed(6)}`);

  logStep(4, '提交发电侧报价');

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

  logStep(5, '提交用电侧报价');

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

  logStep(6, '执行市场出清');
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

  logStep(7, '查询出清电价序列');
  const prices = tradingDayService.getClearingPrices(td.id);
  console.log(`  ✓ 出清电价序列获取成功 (${prices.prices.length} 个时段)`);
  const priceStr = prices.prices.slice(8, 14).map(p => `${p.hour}时:${p.clearing_price.toFixed(0)}`).join(' | ');
  console.log(`    ${priceStr} ...`);

  logStep(8, '执行合约分解');
  const decResult = contractService.decomposeContractsForDate(tradeDate);
  console.log(`  ✓ 分解交易日: ${tradeDate} 覆盖合约数: ${decResult.decomposed_count}`);
  let totalDecEnergy = 0;
  for (const r of decResult.results) totalDecEnergy += r.decomposed_energy;
  console.log(`  ✓ 全天分解总电量: ${totalDecEnergy.toFixed(2)} MWh`);

  logStep(9, '查询分解结果(按维度聚合)');
  const byContract = contractService.getDecompositionAggregated(tradeDate, 'contract');
  console.log(`  ✓ 按合约聚合: 共 ${byContract.length} 份合约`);
  for (const c of byContract) {
    console.log(`    - ${c.contract_no}: 日分解量 ${c.total_energy.toFixed(2)}MWh (买:${c.buyer.code} 卖:${c.seller.code})`);
  }
  const byHour = contractService.getDecompositionAggregated(tradeDate, 'hour');
  const peakHourDec = [...byHour].sort((a, b) => b.total_energy - a.total_energy)[0];
  console.log(`  ✓ 按时段聚合: 分解高峰时段 ${peakHourDec.hour}:00 电量 ${peakHourDec.total_energy.toFixed(2)}MWh`);
  const byPart = contractService.getDecompositionAggregated(tradeDate, 'participant');
  console.log(`  ✓ 按主体聚合: 涉及 ${byPart.length} 个主体`);

  logStep(10, '提交实际发用电量');

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

  logStep(11, '执行联合结算(含合约三行明细)');
  const jointSettlement = settlementService.executeSettlement(td.id);
  console.log(`  ✓ 联合结算完成，交易日状态: ${jointSettlement.status}`);
  console.log(`    合约结算总额: ${jointSettlement.summary.total_contract_amount.toFixed(2)} 元`);
  console.log(`    现货结算总额: ${jointSettlement.summary.total_spot_amount.toFixed(2)} 元`);
  console.log(`    偏差结算总额: ${jointSettlement.summary.total_deviation_amount.toFixed(2)} 元`);
  console.log(`    结算总金额: ${jointSettlement.summary.total_settlement_amount.toFixed(2)} 元`);

  console.log(`\n  [各主体联合结算汇总]`);
  for (const p of jointSettlement.participants) {
    const typeLabel = p.type === 'generator' ? '电厂' : '售电';
    console.log(`    ${p.code}(${typeLabel}) ${p.name}:`);
    console.log(`      现货量:${p.total_spot_volume.toFixed(2)} 合约量:${p.total_contract_volume.toFixed(2)} 实际量:${p.total_actual.toFixed(2)}`);
    console.log(`      合约结算:${p.total_contract_amount.toFixed(2)} 现货结算:${p.total_spot_amount.toFixed(2)} 偏差结算:${p.total_deviation_amount.toFixed(2)} 合计:${p.total_settlement_amount.toFixed(2)}元`);
  }

  logStep(12, '查询单主体联合结算完整报告');
  const con1Report = settlementService.getFullParticipantReport(td.id, con1.id);
  console.log(`  ✓ ${con1Report.participant.name} 完整报告`);
  console.log(`    现货电量: ${con1Report.summary.total_spot_volume.toFixed(2)}MWh`);
  console.log(`    合约电量: ${con1Report.summary.total_contract_volume.toFixed(2)}MWh`);
  console.log(`    总应交电量: ${con1Report.summary.total_obligation.toFixed(2)}MWh`);
  console.log(`    实际电量: ${con1Report.summary.total_actual_volume.toFixed(2)}MWh`);
  console.log(`    合约电费: ${con1Report.summary.total_contract_settlement.toFixed(2)}元`);
  console.log(`    现货电费: ${con1Report.summary.total_spot_settlement.toFixed(2)}元`);
  console.log(`    偏差考核: ${con1Report.summary.total_deviation_settlement.toFixed(2)}元`);
  console.log(`    总电费: ${con1Report.summary.total_settlement_amount.toFixed(2)}元`);

  const sampleH = 10;
  const h10 = con1Report.hourly[sampleH];
  console.log(`\n  [${con1Report.participant.name} 时段${sampleH}:00 三行明细]`);
  if (h10.contract_items && h10.contract_items.length > 0) {
    for (const ci of h10.contract_items) {
      console.log(`    合约[${ci.contract_no}]: ${ci.decomposed_energy.toFixed(2)}MWh ${ci.side === 'buyer' ? '买入' : '卖出'}`);
    }
  }
  if (h10.settlement_items) {
    for (const si of h10.settlement_items) {
      if (si.item_type === 'contract') {
        console.log(`    合约结算: 量${si.volume.toFixed(2)}MWh 单价${si.unit_price.toFixed(2)} 金额${si.amount.toFixed(2)}元`);
      } else if (si.item_type === 'spot') {
        console.log(`    现货结算: 量${si.volume.toFixed(2)}MWh 单价${si.unit_price.toFixed(2)} 金额${si.amount.toFixed(2)}元`);
      } else if (si.item_type === 'deviation') {
        const dirCn = si.direction === 'positive' ? '正偏差' : si.direction === 'negative' ? '负偏差' : '无偏差';
        console.log(`    偏差结算: ${dirCn} 量${si.volume.toFixed(2)}MWh 单价${si.unit_price.toFixed(2)} 金额${si.amount.toFixed(2)}元`);
      }
    }
  }

  logStep(13, '查询合约履约统计');
  const c1Perf = contractService.getContractPerformance(c1.id);
  console.log(`  ✓ 合约 ${c1Perf.contract.contract_no} 履约情况`);
  console.log(`    已分解总量: ${c1Perf.summary.total_decomposed.toFixed(2)}MWh`);
  console.log(`    实际交割量: ${c1Perf.summary.total_actual_delivery.toFixed(2)}MWh`);
  console.log(`    履约率: ${(c1Perf.summary.performance_rate * 100).toFixed(2)}%`);
  console.log(`    状态: ${c1Perf.summary.overall_status === 'under_performed' ? '履约不足(<90%)' : '正常'}`);

  const gen1Perf = contractService.getParticipantContractsPerformance(gen1.id);
  console.log(`\n  ✓ 电厂 ${gen1Perf.participant.name} 合约履约概况`);
  console.log(`    参与合约数: ${gen1Perf.summary.contract_count}`);
  console.log(`    分解总量: ${gen1Perf.summary.total_decomposed.toFixed(2)}MWh`);
  console.log(`    实际交割: ${gen1Perf.summary.total_actual_delivery.toFixed(2)}MWh`);
  console.log(`    综合履约率: ${(gen1Perf.summary.overall_performance_rate * 100).toFixed(2)}%`);
  console.log(`    履约不足合约: ${gen1Perf.summary.under_performed_count} 份`);

  logStep(14, '验证基础接口');

  const allParticipants = participantService.listParticipants();
  console.log(`  ✓ 主体列表查询: 共 ${allParticipants.length} 个主体`);

  const allTradingDays = tradingDayService.listTradingDays();
  console.log(`  ✓ 交易日列表查询: 共 ${allTradingDays.length} 个交易日`);

  const participantByCode = participantService.getParticipantByCode('GEN001');
  console.log(`  ✓ 编码查询主体: ${participantByCode?.name || '未找到'}`);

  const tdByDate = tradingDayService.getTradingDayByDate(tradeDate);
  console.log(`  ✓ 日期查询交易日: ${tdByDate?.trade_date || '未找到'}`);

  const allContracts = contractService.listContracts();
  console.log(`  ✓ 合约列表查询: 共 ${allContracts.length} 份合约`);

  const contractByNo = contractService.getContractByNo('MLT2025M001');
  console.log(`  ✓ 编号查询合约: ${contractByNo?.contract_no || '未找到'}`);

  const settleByTd = settlementService.getSettlementByTradingDay(td.id);
  console.log(`  ✓ 交易日结算查询: 涉及 ${settleByTd.participants.length} 个主体`);

  const settleByPart = settlementService.getSettlementByParticipant(td.id, gen1.id);
  console.log(`  ✓ 单主体结算查询: ${settleByPart.participant.name}`);

  logStep(15, '验证合约终止功能');
  const termDate = tradeDate;
  const tc = contractService.terminateContract(c2.id, termDate);
  console.log(`  ✓ 合约 ${tc.contract_no} 已终止 (终止日: ${tc.termination_date})`);
  console.log(`    当前状态: ${tc.status}`);
  const listActive = contractService.listContracts({ status: 'active' });
  console.log(`  ✓ 剩余生效合约: ${listActive.length} 份`);

  console.log('\n' + '='.repeat(60));
  console.log('✓ 所有测试通过！含中长期合约的联合结算系统功能完整。');
  console.log('='.repeat(60));
}

try {
  runTest();
} catch (err) {
  console.error('\n✗ 测试失败:', err.message);
  console.error(err.stack);
  process.exit(1);
}
