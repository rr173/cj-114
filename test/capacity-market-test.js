const assert = require('assert');
const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, '../data/market.db');
if (fs.existsSync(dbPath)) {
  fs.unlinkSync(dbPath);
}

const db = require('../src/utils/db');
const participantService = require('../src/services/participantService');
const tradingDayService = require('../src/services/tradingDayService');
const biddingService = require('../src/services/biddingService');
const clearingService = require('../src/services/clearingService');
const capacityMarketService = require('../src/services/capacityMarketService');

let gen1, gen2, gen3, consumer1, consumer2, consumer3;
let tradingDay1, tradingDay2, tradingDay3;

function logTest(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (e) {
    console.error(`✗ ${name}`);
    console.error(`  错误: ${e.message}`);
    process.exit(1);
  }
}

console.log('=== 容量市场模块端到端测试 ===\n');

logTest('1. 注册市场主体', () => {
  gen1 = participantService.registerParticipant({
    code: 'GEN001', name: '发电厂A', type: 'generator',
    installed_capacity: 300, min_output: 50, ramp_rate: 30, energy_type: 'thermal'
  });
  assert(gen1.id, 'gen1 注册失败');
  assert.strictEqual(gen1.installed_capacity, 300);

  gen2 = participantService.registerParticipant({
    code: 'GEN002', name: '发电厂B', type: 'generator',
    installed_capacity: 400, min_output: 80, ramp_rate: 40, energy_type: 'thermal'
  });
  assert(gen2.id, 'gen2 注册失败');

  gen3 = participantService.registerParticipant({
    code: 'GEN003', name: '发电厂C', type: 'generator',
    installed_capacity: 150, min_output: 40, ramp_rate: 25, energy_type: 'wind'
  });

  consumer1 = participantService.registerParticipant({
    code: 'CON001', name: '售电公司A', type: 'consumer',
    contracted_capacity: 500
  });
  assert(consumer1.id, 'consumer1 注册失败');

  consumer2 = participantService.registerParticipant({
    code: 'CON002', name: '售电公司B', type: 'consumer',
    contracted_capacity: 300
  });

  consumer3 = participantService.registerParticipant({
    code: 'CON003', name: '售电公司C', type: 'consumer',
    contracted_capacity: 200
  });
});

logTest('2. 设定月度总容量需求', () => {
  const demand = capacityMarketService.setMonthlyDemand('2024-06', 500, 0.15);
  assert(demand, '设定容量需求失败');
  assert.strictEqual(demand.peak_load_forecast, 500);
  assert.strictEqual(demand.reserve_margin, 0.15);
  assert.strictEqual(demand.total_demand_mw, 575);
});

logTest('3. 分配容量义务(首次无历史购电量时平均分配', () => {
  const obligations = capacityMarketService.allocateCapacityObligations('2024-06');
  assert(obligations, '分配容量义务失败');
  assert.strictEqual(obligations.obligations.length, 3);
  
  const expectedObligation = 575 / 3;
  obligations.obligations.forEach(o => {
    assert(Math.abs(o.obligation_mw - expectedObligation) < 0.01);
    assert.strictEqual(o.purchase_share, 1/3);
  });
});

logTest('4. 开放容量竞标窗口', () => {
  const session = capacityMarketService.openBiddingSession('2024-06');
  assert(session, '开放竞标窗口失败');
  assert.strictEqual(session.status, 'bidding');
});

logTest('5. 电厂提交容量竞标', () => {
  const bid1 = capacityMarketService.submitCapacityBid('2024-06', gen1.id, 200, 80000);
  assert(bid1, 'gen1 提交竞标失败');
  assert.strictEqual(bid1.offered_capacity_mw, 200);
  assert.strictEqual(bid1.price_yuan_per_mw_month, 80000);

  const bid2 = capacityMarketService.submitCapacityBid('2024-06', gen2.id, 375, 75000);
  assert(bid2, 'gen2 提交竞标失败');
  assert.strictEqual(bid2.offered_capacity_mw, 375);
  assert.strictEqual(bid2.price_yuan_per_mw_month, 75000);

  const bid3 = capacityMarketService.submitCapacityBid('2024-06', gen3.id, 120, 90000);
  assert(bid3, 'gen3 提交竞标失败');
});

logTest('6. 申报容量不能超过可用上限测试', () => {
  assert.throws(() => {
    capacityMarketService.submitCapacityBid('2024-06', gen1.id, 350, 80000);
  }, /超过可用上限/);
});

logTest('7. 关闭竞标窗口', () => {
  const session = capacityMarketService.closeBiddingSession('2024-06');
  assert.strictEqual(session.status, 'closed');
});

logTest('8. 执行容量出清', () => {
  const result = capacityMarketService.executeCapacityClearing('2024-06');
  assert(result, '容量出清失败');
  assert.strictEqual(result.total_demand_mw, 575);
  assert.strictEqual(result.clearing_price_yuan_per_mw, 80000);
  assert.strictEqual(result.total_cleared_capacity_mw, 575);
  assert.strictEqual(result.winners.length, 2);
});

logTest('9. 验证出清结果 - 按报价排序累加', () => {
  const result = capacityMarketService.getClearingResult('2024-06');
  const winnerPrices = result.winners.map(w => w.clearing_price_yuan_per_mw).sort((a, b) => a - b);
  assert.deepStrictEqual(winnerPrices, [80000, 80000]);
  
  const gen2Allocation = result.winners.find(w => w.participant_id === gen2.id);
  assert(gen2Allocation, 'gen2 应该中标');
  assert.strictEqual(gen2Allocation.committed_capacity_mw, 375);
  assert.strictEqual(gen2Allocation.monthly_compensation_yuan, 375 * 80000);
  
  const gen1Allocation = result.winners.find(w => w.participant_id === gen1.id);
  assert(gen1Allocation, 'gen1 应该中标');
  assert.strictEqual(gen1Allocation.committed_capacity_mw, 200);
  assert.strictEqual(gen1Allocation.monthly_compensation_yuan, 200 * 80000);
  
  const gen3Allocation = result.winners.find(w => w.participant_id === gen3.id);
  assert(!gen3Allocation, 'gen3 不应该中标');
});

logTest('10. 查询某电厂出清结果', () => {
  const result = capacityMarketService.getClearingResultByParticipant('2024-06', gen2.id);
  assert(result.is_winner === 1 || result.is_winner === true);
  assert.strictEqual(result.committed_capacity_mw, 375);
  assert.strictEqual(result.monthly_compensation_yuan, 375 * 80000);
});

console.log('\n=== 准备交易日测试可用性考核 ===');

logTest('11. 创建多个交易日并完成现货出清', () => {
  tradingDay1 = tradingDayService.createTradingDay({
    trade_date: '2024-06-01',
    bid_deadline: new Date(Date.now() + 3600000).toISOString()
  });

  tradingDay2 = tradingDayService.createTradingDay({
    trade_date: '2024-06-02',
    bid_deadline: new Date(Date.now() + 3600000).toISOString()
  });

  tradingDay3 = tradingDayService.createTradingDay({
    trade_date: '2024-06-03',
    bid_deadline: new Date(Date.now() + 3600000).toISOString()
  });

  for (const td of [tradingDay1, tradingDay2, tradingDay3]) {
    const gen1Bids = [];
    const gen2Bids = [];
    const gen3Bids = [];
    const con1Bids = [];
    const con2Bids = [];
    const con3Bids = [];

    for (let h = 0; h < 24; h++) {
      gen1Bids.push({ hour: h, segments: [{ price: 300, capacity: 250 }] });
      gen2Bids.push({ hour: h, segments: [{ price: 280, capacity: 30 }] });
      gen3Bids.push({ hour: h, segments: [{ price: 320, capacity: 140 }] });
      
      const demand = h >= 8 && h <= 20 ? 150 : 80;
      con1Bids.push({ hour: h, demand: demand, max_price: 500 });
      con2Bids.push({ hour: h, demand: demand * 0.6, max_price: 480 });
      con3Bids.push({ hour: h, demand: demand * 0.4, max_price: 490 });
    }

    biddingService.submitGeneratorBid(td.id, gen1.id, gen1Bids);
    biddingService.submitGeneratorBid(td.id, gen2.id, gen2Bids);
    biddingService.submitGeneratorBid(td.id, gen3.id, gen3Bids);
    biddingService.submitConsumerBid(td.id, consumer1.id, con1Bids);
    biddingService.submitConsumerBid(td.id, consumer2.id, con2Bids);
    biddingService.submitConsumerBid(td.id, consumer3.id, con3Bids);

    clearingService.executeClearing(td.id);
  }
});

logTest('12. 查询容量缺失事件 - 无检修故障时不应有缺失', () => {
  const events = capacityMarketService.getShortageEvents('2024-06');
  assert.strictEqual(events.length, 0, '无检修故障时不应有容量缺失事件');
});

logTest('13. 查询某电厂容量缺失事件 - 无检修故障时应为空', () => {
  const events = capacityMarketService.getShortageEvents('2024-06', gen2.id);
  assert.strictEqual(events.length, 0, 'gen2 无检修故障时不应有容量缺失事件');
});

logTest('14. 计算月度可用性考核', () => {
  const assessment = capacityMarketService.calculateAvailabilityAssessment('2024-06');
  assert(assessment, '可用性考核失败');
  assert.strictEqual(assessment.threshold_rate, 0.95);
  assert.strictEqual(assessment.assessments.length, 2);
});

logTest('15. 验证可用性考核计算 - 无检修故障时100%可用', () => {
  const assessment = capacityMarketService.getAvailabilityAssessments('2024-06');
  const gen2Assessment = assessment.assessments.find(a => a.participant_id === gen2.id);
  assert(gen2Assessment, 'gen2 考核结果不存在');
  assert.strictEqual(gen2Assessment.availability_rate, 1, 'gen2 无检修故障时可用率应为100%');
  assert.strictEqual(gen2Assessment.deduction_amount, 0, 'gen2 无检修故障时不应有扣减');
  assert.strictEqual(gen2Assessment.is_compliant, 1, 'gen2 应达标');
  assert.strictEqual(gen2Assessment.final_compensation, gen2Assessment.original_compensation, 'gen2 无扣减时最终补偿应等于原始补偿');

  const gen1Assessment = assessment.assessments.find(a => a.participant_id === gen1.id);
  assert.strictEqual(gen1Assessment.availability_rate, 1, 'gen1 可用率应为100%');
  assert.strictEqual(gen1Assessment.deduction_amount, 0, 'gen1 不应有扣减');
});

logTest('16. 生成分月容量结算单', () => {
  const settlement = capacityMarketService.generateMonthlySettlement('2024-06');
  assert(settlement, '生成结算单失败');
  assert(settlement.generator_settlements.length === 2);
  assert(settlement.consumer_settlements.length === 3);
});

logTest('17. 验证结算单金额平衡 - 无扣减时全额支付', () => {
  const settlement = capacityMarketService.getSettlement('2024-06');
  assert(settlement != null);
  
  assert(settlement.total_deduction === 0, '无扣减时总扣减应为0');
  assert(settlement.net_payable === settlement.total_compensation, '无扣减时净支付应等于总补偿');
  
  const totalGenCompensation = settlement.generator_settlements.reduce((sum, g) => sum + g.net_compensation, 0);
  const totalConsumerPayable = settlement.consumer_settlements.reduce((sum, c) => sum + c.net_amount, 0);
  
  assert(Math.abs(totalGenCompensation - settlement.net_payable) < 0.01, '电厂应收净额应等于净支付总额');
  assert(Math.abs(totalGenCompensation - totalConsumerPayable) < 0.01, '电厂应收应等于售电公司应付');

  const expectedTotal = 200 * 80000 + 375 * 80000;
  assert.strictEqual(settlement.total_compensation, expectedTotal, '总补偿应等于两家中标电厂补偿之和');
});

logTest('18. 验证售电公司分摊按义务占比分摊 - 无扣减时全额分摊', () => {
  const settlement = capacityMarketService.getSettlement('2024-06');
  const totalObligation = settlement.consumer_settlements.reduce((sum, c) => sum + c.obligation_mw, 0);
  
  assert(settlement.net_payable > 0, '净支付应大于0');
  
  settlement.consumer_settlements.forEach(c => {
    const expectedRatio = c.obligation_mw / totalObligation;
    const storedRatio = c.share_ratio;
    assert(Math.abs(expectedRatio - storedRatio) < 0.001, '存储的分摊比例应与义务占比一致');
    const actualRatioFromNet = c.net_amount / settlement.net_payable;
    assert(Math.abs(expectedRatio - actualRatioFromNet) < 0.001, '实际净支付比例应与义务占比一致');
    assert(c.net_amount > 0, '售电公司应付金额应大于0');
  });

  settlement.generator_settlements.forEach(g => {
    assert(g.capacity_mw != null, '电厂容量应存在');
    assert(g.total_compensation != null, '电厂总补偿应存在');
    assert(g.total_compensation > 0, '电厂总补偿应大于0');
    assert.strictEqual(g.total_deduction, 0, '电厂扣减应为0');
    assert.strictEqual(g.net_compensation, g.total_compensation, '电厂净补偿应等于总补偿');
    assert(g.availability_rate === 1, '电厂可用率应为100%');
    assert(g.shortage_periods === 0, '电厂缺失时段数应为0');
  });
});

logTest('19. 查询历史出清价趋势', () => {
  const history = capacityMarketService.getClearingPriceHistory();
  assert(history.length >= 1);
  assert.strictEqual(history[0].month, '2024-06');
  assert.strictEqual(history[0].clearing_price_yuan_per_mw, 80000);
});

logTest('20. 验证查询单主体容量义务', () => {
  const obligation = capacityMarketService.getCapacityObligations('2024-06', consumer1.id);
  assert(obligation, '查询单主体义务失败');
  assert.strictEqual(obligation.obligations.length, 1);
  assert.strictEqual(obligation.obligations[0].participant_id, consumer1.id);
});

console.log('\n=== 验证第二月测试 - 基于历史购电量分配义务 ===');

logTest('21. 提交实际成交量用于下月义务分配', () => {
  db.prepare(`
    INSERT INTO actual_volumes (id, trading_day_id, participant_id, hour, actual_volume)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    require('uuid').v4(), tradingDay1.id, consumer1.id, 12, 100
  );
  db.prepare(`
    INSERT INTO actual_volumes (id, trading_day_id, participant_id, hour, actual_volume)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    require('uuid').v4(), tradingDay1.id, consumer2.id, 12, 60
  );
  db.prepare(`
    INSERT INTO actual_volumes (id, trading_day_id, participant_id, hour, actual_volume)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    require('uuid').v4(), tradingDay1.id, consumer3.id, 12, 40
  );
});

logTest('22. 设定第二月容量需求', () => {
  capacityMarketService.setMonthlyDemand('2024-07', 600, 0.15);
});

logTest('23. 第二月容量义务按购电量占比分配', () => {
  const obligations = capacityMarketService.allocateCapacityObligations('2024-07');
  assert(obligations, '分配第二月义务失败');
  
  const totalDemand = 600 * 1.15;
  const totalPurchase = 100 + 60 + 40;
  
  const c1Obligation = obligations.obligations.find(o => o.participant_id === consumer1.id);
  assert(Math.abs(c1Obligation.obligation_mw - totalDemand * (100 / totalPurchase)) < 0.01);
  
  const c2Obligation = obligations.obligations.find(o => o.participant_id === consumer2.id);
  assert(Math.abs(c2Obligation.obligation_mw - totalDemand * (60 / totalPurchase)) < 0.01);
  
  const c3Obligation = obligations.obligations.find(o => o.participant_id === consumer3.id);
  assert(Math.abs(c3Obligation.obligation_mw - totalDemand * (40 / totalPurchase)) < 0.01);
});

logTest('24. 查询第二月容量竞标和出清', () => {
  capacityMarketService.openBiddingSession('2024-07');
  capacityMarketService.submitCapacityBid('2024-07', gen1.id, 180, 85000);
  capacityMarketService.submitCapacityBid('2024-07', gen2.id, 280, 78000);
  capacityMarketService.closeBiddingSession('2024-07');
  const result = capacityMarketService.executeCapacityClearing('2024-07');
  assert(result, '第二月出清失败');
});

logTest('25. 出清价趋势包含两个月', () => {
  const history = capacityMarketService.getClearingPriceHistory();
  assert.strictEqual(history.length, 2);
  assert.strictEqual(history[0].month, '2024-06');
  assert.strictEqual(history[1].month, '2024-07');
});

console.log('\n=== 全部测试通过 ✓ ===');
process.exit(0);
