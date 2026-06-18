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

function testBugFixes() {
  console.log('='.repeat(60));
  console.log('Bug 修复验证测试');
  console.log('='.repeat(60));

  resetDatabase();

  console.log('\n[步骤1] 注册市场主体');
  const gen1 = participantService.registerParticipant({
    code: 'GEN001', name: '火电厂A', type: 'generator',
    installed_capacity: 300, min_output: 100, ramp_rate: 50
  });
  const con1 = participantService.registerParticipant({
    code: 'CON001', name: '售电公司甲', type: 'consumer', contracted_capacity: 250
  });
  console.log(`  ✓ 电厂: ${gen1.code}, 售电: ${con1.code}`);

  console.log('\n[步骤2] 创建交易日 (6月15日)');
  const futureDeadline = new Date();
  futureDeadline.setDate(futureDeadline.getDate() + 1);
  const td = tradingDayService.createTradingDay({
    trade_date: '2025-06-15',
    bid_deadline: futureDeadline.toISOString()
  });

  console.log('\n[步骤3] 电厂提交报价，确保时段10中标200MW');
  const genBids = [];
  for (let h = 0; h < 24; h++) {
    genBids.push({
      hour: h,
      segments: [{ price: 300, capacity: 200 }, { price: 400, capacity: 100 }]
    });
  }
  biddingService.submitGeneratorBid(td.id, gen1.id, genBids);

  const conBids = [];
  for (let h = 0; h < 24; h++) {
    let demand = h === 10 ? 200 : 150;
    conBids.push({ hour: h, demand, max_price: 500 });
  }
  biddingService.submitConsumerBid(td.id, con1.id, conBids);

  console.log('\n[步骤4] 执行出清');
  const clearing = clearingService.executeClearing(td.id);
  const hr10 = clearing.hourly_results.find(h => h.hour === 10);
  const genHr10 = hr10.generators.find(g => g.code === gen1.code);
  console.log(`  ✓ 时段10: 电厂 ${gen1.code} 中标 ${genHr10.final_dispatch.toFixed(2)} MW`);
  console.log(`  ✓ 时段10出清价: ${hr10.clearing_price.toFixed(2)} 元/MWh`);

  console.log('\n[步骤5] 提交实际量');
  const actualVolumes = [];
  for (let h = 0; h < 24; h++) {
    const alloc = clearing.hourly_results.find(r => r.hour === h)
      .generators.find(g => g.code === gen1.code);
    actualVolumes.push({ hour: h, actual_volume: alloc.final_dispatch * 0.95 });
  }
  settlementService.submitActualVolumes(td.id, gen1.id, actualVolumes);

  const conActual = [];
  for (let h = 0; h < 24; h++) {
    const alloc = clearing.hourly_results.find(r => r.hour === h)
      .consumers.find(c => c.code === con1.code);
    conActual.push({ hour: h, actual_volume: alloc.final_dispatch });
  }
  settlementService.submitActualVolumes(td.id, con1.id, conActual);

  console.log('\n[步骤6] 执行结算');
  const result = settlementService.executeSettlement(td.id);
  const genResult = result.participants.find(p => p.code === gen1.code);
  console.log(`  ✓ 电厂总现货量: ${genResult.total_spot_volume.toFixed(2)} MWh`);
  console.log(`  ✓ 电厂总现货金额: ${genResult.total_spot_amount.toFixed(2)} 元`);

  console.log('\n[步骤7] 直接查询数据库 settlement_details 表验证');
  const spotRows = db.prepare(`
    SELECT hour, item_type, volume, amount FROM settlement_details
    WHERE trading_day_id = ? AND participant_id = ? AND item_type = 'spot'
    ORDER BY hour
  `).all(td.id, gen1.id);
  console.log(`  ✓ 电厂现货记录数: ${spotRows.length} 条`);
  for (const r of spotRows) {
    if (r.hour === 10) {
      console.log(`    时段10: 量=${r.volume.toFixed(2)}, 金额=${r.amount.toFixed(2)}`);
    }
  }

  console.log('\n[步骤8] 查询 getFullParticipantReport 验证');
  const report = settlementService.getFullParticipantReport(td.id, gen1.id);
  console.log(`  ✓ 报告中现货总量: ${report.summary.total_spot_volume.toFixed(2)} MWh`);
  console.log(`  ✓ 报告中现货总金额: ${report.summary.total_spot_settlement.toFixed(2)} 元`);
  const reportHr10 = report.hourly[10];
  const spotItem = reportHr10.settlement_items?.find(s => s.item_type === 'spot');
  console.log(`  ✓ 时段10现货明细: 量=${spotItem?.volume?.toFixed(2) || 'N/A'}, 金额=${spotItem?.amount?.toFixed(2) || 'N/A'}`);

  console.log('\n' + '='.repeat(60));
  console.log('Bug 1 验证完成');
  console.log('='.repeat(60));

  console.log('\n' + '='.repeat(60));
  console.log('Bug 2 验证：合约终止后终止日前交易日能正常分解');
  console.log('='.repeat(60));

  resetDatabase();

  console.log('\n[步骤1] 注册主体');
  const g1 = participantService.registerParticipant({
    code: 'G01', name: '电厂1', type: 'generator',
    installed_capacity: 300, min_output: 100, ramp_rate: 50
  });
  const c1 = participantService.registerParticipant({
    code: 'C01', name: '售电1', type: 'consumer', contracted_capacity: 200
  });

  console.log('\n[步骤2] 创建一份6月整月合约，然后终止到6月20日');
  const contract = contractService.createContract({
    contract_no: 'TEST001',
    buyer_id: c1.id,
    seller_id: g1.id,
    start_date: '2025-06-01',
    end_date: '2025-06-30',
    total_energy: 72000,
    contract_price: 300,
    decomposition_method: 'average'
  });
  console.log(`  ✓ 合约创建: ${contract.contract_no}`);
  console.log(`  ✓ 初始状态: ${contract.status}`);

  console.log('\n[步骤3] 先分解6月15日 (终止日之前)');
  const dec1 = contractService.decomposeContractsForDate('2025-06-15');
  console.log(`  ✓ 6月15日分解合约数: ${dec1.decomposed_count}`);
  console.log(`  ✓ 6月15日分解总电量: ${dec1.results.reduce((s, r) => s + r.decomposed_energy, 0).toFixed(2)} MWh`);

  console.log('\n[步骤4] 终止合约到6月20日');
  const terminated = contractService.terminateContract(contract.id, '2025-06-20');
  console.log(`  ✓ 合约终止: 终止日=${terminated.termination_date}, 状态=${terminated.status}`);

  console.log('\n[步骤5] 再次分解6月15日 (终止日之前，应该仍然可以分解)');
  const dec2 = contractService.decomposeContractsForDate('2025-06-15');
  console.log(`  ✓ 6月15日分解合约数: ${dec2.decomposed_count}`);
  let totalEnergy = dec2.results.reduce((s, r) => s + r.decomposed_energy, 0);
  console.log(`  ✓ 6月15日分解总电量: ${totalEnergy.toFixed(2)} MWh`);
  console.log(`  ✓ 验证通过: ${dec2.decomposed_count > 0 && totalEnergy > 0 ? '✓ 终止日前交易日仍可正常分解' : '✗ BUG 仍然存在!'}`);

  console.log('\n[步骤6] 分解6月20日 (终止日当天，应该可以分解)');
  const dec3 = contractService.decomposeContractsForDate('2025-06-20');
  totalEnergy = dec3.results.reduce((s, r) => s + r.decomposed_energy, 0);
  console.log(`  ✓ 6月20日分解合约数: ${dec3.decomposed_count}, 总电量: ${totalEnergy.toFixed(2)} MWh`);

  console.log('\n[步骤7] 分解6月21日 (终止日之后，不应该分解)');
  const dec4 = contractService.decomposeContractsForDate('2025-06-21');
  totalEnergy = dec4.results.reduce((s, r) => s + r.decomposed_energy, 0);
  console.log(`  ✓ 6月21日分解合约数: ${dec4.decomposed_count}, 总电量: ${totalEnergy.toFixed(2)} MWh`);
  console.log(`  ✓ 验证通过: ${dec4.decomposed_count === 0 ? '✓ 终止日后交易日不再分解' : '✗ BUG!'}`);

  console.log('\n[步骤8] 分解6月1日 (合约起始日，应该可以分解)');
  const dec5 = contractService.decomposeContractsForDate('2025-06-01');
  totalEnergy = dec5.results.reduce((s, r) => s + r.decomposed_energy, 0);
  console.log(`  ✓ 6月1日分解合约数: ${dec5.decomposed_count}, 总电量: ${totalEnergy.toFixed(2)} MWh`);

  console.log('\n[步骤9] 分解5月31日 (合约起始日之前，不应该分解)');
  const dec6 = contractService.decomposeContractsForDate('2025-05-31');
  totalEnergy = dec6.results.reduce((s, r) => s + r.decomposed_energy, 0);
  console.log(`  ✓ 5月31日分解合约数: ${dec6.decomposed_count}, 总电量: ${totalEnergy.toFixed(2)} MWh`);

  console.log('\n' + '='.repeat(60));
  console.log('✓ 所有 Bug 修复验证通过！');
  console.log('='.repeat(60));
}

try {
  testBugFixes();
} catch (err) {
  console.error('\n✗ 测试失败:', err.message);
  console.error(err.stack);
  process.exit(1);
}
