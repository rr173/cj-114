const db = require('../src/utils/db');
const participantService = require('../src/services/participantService');
const tradingDayService = require('../src/services/tradingDayService');
const biddingService = require('../src/services/biddingService');
const clearingService = require('../src/services/clearingService');

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
}

function testClearingPrice() {
  console.log('='.repeat(60));
  console.log('测试1：出清电价验证');
  console.log('='.repeat(60));

  const gen = participantService.registerParticipant({
    code: 'TEST_GEN',
    name: '测试电厂',
    type: 'generator',
    installed_capacity: 500,
    min_output: 50,
    ramp_rate: 100
  });

  const con = participantService.registerParticipant({
    code: 'TEST_CON',
    name: '测试售电',
    type: 'consumer',
    contracted_capacity: 300
  });

  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + 1);
  const tradeDate = futureDate.toISOString().split('T')[0];
  const deadline = new Date(futureDate.getTime() + 24 * 3600 * 1000).toISOString();

  const td = tradingDayService.createTradingDay({
    trade_date: tradeDate,
    bid_deadline: deadline
  });

  biddingService.submitGeneratorBid(td.id, gen.id, [{
    hour: 10,
    segments: [
      { price: 200, capacity: 100 },
      { price: 300, capacity: 100 },
      { price: 350, capacity: 100 },
      { price: 400, capacity: 100 }
    ]
  }]);

  biddingService.submitConsumerBid(td.id, con.id, [{
    hour: 10,
    demand: 150,
    max_price: 500
  }]);

  console.log('\n  [供给曲线]');
  console.log('    第1段: 200元/MWh, 100MW (累计100MW)');
  console.log('    第2段: 300元/MWh, 100MW (累计200MW)');
  console.log('    第3段: 350元/MWh, 100MW (累计300MW)');
  console.log('    第4段: 400元/MWh, 100MW (累计400MW)');
  console.log('  [需求]');
  console.log('    需求: 150MW, 最高可接受价: 500元/MWh');
  console.log('\n  预期: 到300元档时累计供给200MW > 150MW需求');
  console.log('  预期出清价: 300元/MWh (而不是350元)');

  const result = clearingService.executeClearing(td.id);
  const hr10 = result.hourly_results[10];

  console.log(`\n  实际出清价: ${hr10.clearing_price} 元/MWh`);
  console.log(`  实际出清量: ${hr10.clearing_volume} MW`);

  if (Math.abs(hr10.clearing_price - 300) < 0.01) {
    console.log('  ✓ 出清电价正确！');
  } else {
    console.log('  ✗ 出清电价偏高！预期300元/MWh');
  }

  console.log();
  resetDatabase();
}

function testRampConstraint() {
  console.log('='.repeat(60));
  console.log('测试2：爬坡约束验证（只截高的，不提低的）');
  console.log('='.repeat(60));

  const gen = participantService.registerParticipant({
    code: 'RAMP_GEN',
    name: '爬坡测试电厂',
    type: 'generator',
    installed_capacity: 300,
    min_output: 0,
    ramp_rate: 50
  });

  const con = participantService.registerParticipant({
    code: 'RAMP_CON',
    name: '爬坡测试售电',
    type: 'consumer',
    contracted_capacity: 400
  });

  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + 1);
  const tradeDate = futureDate.toISOString().split('T')[0];
  const deadline = new Date(futureDate.getTime() + 24 * 3600 * 1000).toISOString();

  const td = tradingDayService.createTradingDay({
    trade_date: tradeDate,
    bid_deadline: deadline
  });

  const bids = [];
  for (let h = 0; h < 24; h++) {
    let capacity = 200;
    if (h >= 5 && h <= 8) {
      capacity = 50;
    }
    if (h >= 18 && h <= 22) {
      capacity = 250;
    }
    bids.push({
      hour: h,
      segments: [{ price: 200, capacity: capacity }]
    });
  }
  biddingService.submitGeneratorBid(td.id, gen.id, bids);

  const conBids = [];
  for (let h = 0; h < 24; h++) {
    conBids.push({ hour: h, demand: 300, max_price: 500 });
  }
  biddingService.submitConsumerBid(td.id, con.id, conBids);

  console.log('\n  初始中标情况（部分时段）:');
  console.log('    时段4: 200MW');
  console.log('    时段5: 50MW  (低谷)');
  console.log('    时段6: 50MW  (低谷)');
  console.log('    时段7: 50MW  (低谷)');
  console.log('    时段8: 50MW  (低谷)');
  console.log('    时段9: 200MW');
  console.log('  爬坡速率: 50MW/h');
  console.log();
  console.log('  上升约束(时段8→9): 50→200, 变化+150 > 50');
  console.log('    应该截高的(时段9): 200 → 50+50=100MW');
  console.log();
  console.log('  下降约束(时段4→5): 200→50, 变化-150 > 50');
  console.log('    应该截高的(时段4): 200 → 50+50=100MW (而不是把时段5提上来)');

  const result = clearingService.executeClearing(td.id);

  console.log('\n  调整后结果:');
  for (let h = 3; h <= 10; h++) {
    const hr = result.hourly_results[h];
    const genAlloc = hr.generators.find(g => g.code === 'RAMP_GEN');
    const init = genAlloc ? genAlloc.initial_allocation.toFixed(0) : '0';
    const final = genAlloc ? genAlloc.final_dispatch.toFixed(0) : '0';
    const reason = genAlloc?.adjustment_reason || '';
    const diff = (genAlloc ? (genAlloc.final_dispatch - genAlloc.initial_allocation) : 0).toFixed(0);
    const arrow = diff > 0 ? '↑' : diff < 0 ? '↓' : ' ';
    console.log(`    时段${h.toString().padStart(2, '0')}: 初始${init}MW → 最终${final}MW ${arrow}${Math.abs(diff)} ${reason}`);
  }

  const hr8 = result.hourly_results[8].generators.find(g => g.code === 'RAMP_GEN');
  const hr9 = result.hourly_results[9].generators.find(g => g.code === 'RAMP_GEN');
  const hr4 = result.hourly_results[4].generators.find(g => g.code === 'RAMP_GEN');
  const hr5 = result.hourly_results[5].generators.find(g => g.code === 'RAMP_GEN');

  console.log('\n  验证:');

  const rampUpOk = hr9.final_dispatch <= hr8.final_dispatch + 50.01;
  console.log(`    上升约束(8→9): ${hr8.final_dispatch.toFixed(0)} → ${hr9.final_dispatch.toFixed(0)}`);
  console.log(`    差值: ${(hr9.final_dispatch - hr8.final_dispatch).toFixed(0)}MW ≤ 50MW ? ${rampUpOk ? '✓' : '✗'}`);

  const rampDownOk = hr4.final_dispatch <= hr5.final_dispatch + 50.01;
  console.log(`    下降约束(4→5): ${hr4.final_dispatch.toFixed(0)} → ${hr5.final_dispatch.toFixed(0)}`);
  console.log(`    差值: ${(hr4.final_dispatch - hr5.final_dispatch).toFixed(0)}MW ≤ 50MW ? ${rampDownOk ? '✓' : '✗'}`);

  const hr5NotIncreased = hr5.final_dispatch <= 50.01;
  console.log(`    时段5没有被往上提: 最终${hr5.final_dispatch.toFixed(0)}MW ≤ 50MW ? ${hr5NotIncreased ? '✓' : '✗'}`);

  const hr4Decreased = hr4.final_dispatch < 199.99;
  console.log(`    时段4被截低了: 最终${hr4.final_dispatch.toFixed(0)}MW < 200MW ? ${hr4Decreased ? '✓' : '✗'}`);

  if (rampUpOk && rampDownOk && hr5NotIncreased && hr4Decreased) {
    console.log('\n  ✓ 爬坡约束正确！只截高的，不提低的');
  } else {
    console.log('\n  ✗ 爬坡约束有问题');
  }

  console.log();
  resetDatabase();
}

console.log('\n');
testClearingPrice();
testRampConstraint();
console.log('='.repeat(60));
console.log('验证完成');
console.log('='.repeat(60));
