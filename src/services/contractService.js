const { v4: uuidv4 } = require('uuid');
const db = require('../utils/db');
const { getParticipantById } = require('./participantService');
const { getTradingDayById, getTradingDayByDate } = require('./tradingDayService');

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function daysBetween(startDate, endDate) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const diff = end.getTime() - start.getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24)) + 1;
}

function isValidDate(dateStr) {
  return DATE_PATTERN.test(dateStr) && !isNaN(new Date(dateStr).getTime());
}

function createContract(data) {
  const {
    contract_no,
    buyer_id,
    seller_id,
    start_date,
    end_date,
    total_energy,
    contract_price,
    decomposition_method,
    decomposition_curve
  } = data;

  if (!contract_no) throw new Error('合约编号为必填项');
  if (!buyer_id) throw new Error('买方(售电公司)ID为必填项');
  if (!seller_id) throw new Error('卖方(电厂)ID为必填项');
  if (!start_date) throw new Error('合约起始日期为必填项');
  if (!end_date) throw new Error('合约结束日期为必填项');
  if (total_energy == null || total_energy <= 0) throw new Error('总签约电量必须大于0');
  if (contract_price == null || contract_price <= 0) throw new Error('合约结算单价必须大于0');
  if (!decomposition_method) throw new Error('分解方式为必填项');

  if (!isValidDate(start_date)) throw new Error('起始日期格式应为 YYYY-MM-DD');
  if (!isValidDate(end_date)) throw new Error('结束日期格式应为 YYYY-MM-DD');
  if (new Date(start_date) > new Date(end_date)) throw new Error('起始日期不能晚于结束日期');

  if (!['average', 'curve'].includes(decomposition_method)) {
    throw new Error('分解方式必须是 average(平均分解) 或 curve(按典型曲线分解)');
  }

  const existing = db.prepare('SELECT id FROM mid_long_term_contracts WHERE contract_no = ?').get(contract_no);
  if (existing) throw new Error('合约编号已存在');

  const buyer = getParticipantById(buyer_id);
  if (!buyer) throw new Error('买方(售电公司)不存在');
  if (buyer.type !== 'consumer') throw new Error('买方必须是售电公司(consumer类型)');

  const seller = getParticipantById(seller_id);
  if (!seller) throw new Error('卖方(电厂)不存在');
  if (seller.type !== 'generator') throw new Error('卖方必须是电厂(generator类型)');

  if (decomposition_method === 'curve') {
    if (!Array.isArray(decomposition_curve) || decomposition_curve.length !== 24) {
      throw new Error('典型曲线分解需提供24个时段的比例数组');
    }
    let sum = 0;
    for (let i = 0; i < 24; i++) {
      const ratio = decomposition_curve[i];
      if (ratio == null || ratio < 0) throw new Error(`时段 ${i} 比例无效`);
      sum += ratio;
    }
    if (Math.abs(sum - 1.0) > 0.0001) {
      throw new Error(`24个时段比例之和必须等于1，当前和为 ${sum.toFixed(4)}`);
    }
  }

  const id = uuidv4();

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO mid_long_term_contracts
      (id, contract_no, buyer_id, seller_id, start_date, end_date, total_energy, contract_price, decomposition_method, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
    `).run(id, contract_no, buyer_id, seller_id, start_date, end_date, total_energy, contract_price, decomposition_method);

    if (decomposition_method === 'curve') {
      const insertCurve = db.prepare(`
        INSERT INTO contract_decomposition_curves (id, contract_id, hour, ratio)
        VALUES (?, ?, ?, ?)
      `);
      for (let h = 0; h < 24; h++) {
        insertCurve.run(uuidv4(), id, h, decomposition_curve[h]);
      }
    }
  });

  tx();

  return getContractById(id);
}

function getContractById(id) {
  const contract = db.prepare('SELECT * FROM mid_long_term_contracts WHERE id = ?').get(id);
  if (!contract) return null;
  return _enrichContract(contract);
}

function getContractByNo(contractNo) {
  const contract = db.prepare('SELECT * FROM mid_long_term_contracts WHERE contract_no = ?').get(contractNo);
  if (!contract) return null;
  return _enrichContract(contract);
}

function listContracts(params = {}) {
  const { participant_id, status, buyer_id, seller_id } = params;
  let sql = 'SELECT * FROM mid_long_term_contracts WHERE 1=1';
  const args = [];

  if (participant_id) {
    sql += ' AND (buyer_id = ? OR seller_id = ?)';
    args.push(participant_id, participant_id);
  }
  if (buyer_id) { sql += ' AND buyer_id = ?'; args.push(buyer_id); }
  if (seller_id) { sql += ' AND seller_id = ?'; args.push(seller_id); }
  if (status) { sql += ' AND status = ?'; args.push(status); }

  sql += ' ORDER BY created_at DESC';
  const rows = db.prepare(sql).all(...args);
  return rows.map(r => _enrichContract(r));
}

function _enrichContract(contract) {
  const buyer = getParticipantById(contract.buyer_id);
  const seller = getParticipantById(contract.seller_id);
  const enriched = {
    ...contract,
    buyer: buyer ? { id: buyer.id, code: buyer.code, name: buyer.name } : null,
    seller: seller ? { id: seller.id, code: seller.code, name: seller.name } : null
  };

  if (contract.decomposition_method === 'curve') {
    const curveRows = db.prepare(`
      SELECT hour, ratio FROM contract_decomposition_curves
      WHERE contract_id = ? ORDER BY hour
    `).all(contract.id);
    enriched.decomposition_curve = curveRows.map(r => r.ratio);
  } else {
    enriched.decomposition_curve = null;
  }

  return enriched;
}

function terminateContract(contractId, terminationDate) {
  const contract = db.prepare('SELECT * FROM mid_long_term_contracts WHERE id = ?').get(contractId);
  if (!contract) throw new Error('合约不存在');
  if (contract.status === 'terminated') throw new Error('合约已终止');

  if (!terminationDate) throw new Error('终止日期为必填项');
  if (!isValidDate(terminationDate)) throw new Error('终止日期格式应为 YYYY-MM-DD');
  if (new Date(terminationDate) < new Date(contract.start_date)) {
    throw new Error('终止日期不能早于合约起始日期');
  }

  const effEndDate = contract.termination_date || contract.end_date;
  if (new Date(terminationDate) > new Date(effEndDate)) {
    throw new Error('终止日期不能晚于合约结束日期');
  }

  db.prepare(`
    UPDATE mid_long_term_contracts SET status = 'terminated', termination_date = ? WHERE id = ?
  `).run(terminationDate, contractId);

  return getContractById(contractId);
}

function decomposeContractsForDate(tradeDate) {
  if (!tradeDate) throw new Error('交易日期为必填项');
  if (!isValidDate(tradeDate)) throw new Error('交易日期格式应为 YYYY-MM-DD');

  const td = getTradingDayByDate(tradeDate);
  const tradingDayId = td ? td.id : null;

  const contracts = db.prepare(`
    SELECT * FROM mid_long_term_contracts WHERE status = 'active'
  `).all();

  const effectiveContracts = contracts.filter(c => {
    const start = new Date(c.start_date);
    const effectiveEnd = c.termination_date ? new Date(c.termination_date) : new Date(c.end_date);
    const target = new Date(tradeDate);
    return target >= start && target <= effectiveEnd;
  });

  if (effectiveContracts.length === 0) {
    return { trade_date: tradeDate, decomposed_count: 0, results: [] };
  }

  const tx = db.transaction(() => {
    db.prepare(`
      DELETE FROM contract_decomposition_results WHERE trade_date = ?
    `).run(tradeDate);

    const insertStmt = db.prepare(`
      INSERT INTO contract_decomposition_results
      (id, contract_id, trading_day_id, trade_date, hour, decomposed_energy, buyer_id, seller_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const contract of effectiveContracts) {
      const start = contract.start_date;
      const end = contract.termination_date || contract.end_date;
      const totalDays = daysBetween(start, end);
      const dailyEnergy = contract.total_energy / totalDays;

      if (contract.decomposition_method === 'average') {
        const hourlyEnergy = dailyEnergy / 24;
        for (let h = 0; h < 24; h++) {
          insertStmt.run(
            uuidv4(), contract.id, tradingDayId, tradeDate, h,
            hourlyEnergy, contract.buyer_id, contract.seller_id
          );
        }
      } else {
        const curve = db.prepare(`
          SELECT hour, ratio FROM contract_decomposition_curves
          WHERE contract_id = ? ORDER BY hour
        `).all(contract.id);
        for (const c of curve) {
          const hourlyEnergy = dailyEnergy * c.ratio;
          insertStmt.run(
            uuidv4(), contract.id, tradingDayId, tradeDate, c.hour,
            hourlyEnergy, contract.buyer_id, contract.seller_id
          );
        }
      }
    }
  });

  tx();

  return {
    trade_date: tradeDate,
    decomposed_count: effectiveContracts.length,
    results: getDecompositionByDate(tradeDate)
  };
}

function getDecompositionByDate(tradeDate) {
  const rows = db.prepare(`
    SELECT dr.*, c.contract_no,
           bc.code AS buyer_code, bc.name AS buyer_name,
           sc.code AS seller_code, sc.name AS seller_name
    FROM contract_decomposition_results dr
    JOIN mid_long_term_contracts c ON dr.contract_id = c.id
    JOIN market_participants bc ON dr.buyer_id = bc.id
    JOIN market_participants sc ON dr.seller_id = sc.id
    WHERE dr.trade_date = ?
    ORDER BY dr.hour, c.contract_no
  `).all(tradeDate);
  return rows;
}

function getDecompositionByTradingDay(tradingDayId) {
  const td = getTradingDayById(tradingDayId);
  if (!td) throw new Error('交易日不存在');
  return getDecompositionByDate(td.trade_date);
}

function getDecompositionAggregated(tradeDate, dimension) {
  const results = getDecompositionByDate(tradeDate);

  if (dimension === 'hour') {
    const byHour = {};
    for (let h = 0; h < 24; h++) byHour[h] = { hour: h, total_energy: 0, contract_count: 0 };
    for (const r of results) {
      byHour[r.hour].total_energy += r.decomposed_energy;
      byHour[r.hour].contract_count++;
    }
    return Object.values(byHour);
  }

  if (dimension === 'contract') {
    const byContract = {};
    for (const r of results) {
      if (!byContract[r.contract_id]) {
        byContract[r.contract_id] = {
          contract_id: r.contract_id,
          contract_no: r.contract_no,
          buyer: { id: r.buyer_id, code: r.buyer_code, name: r.buyer_name },
          seller: { id: r.seller_id, code: r.seller_code, name: r.seller_name },
          total_energy: 0,
          hourly: []
        };
      }
      byContract[r.contract_id].total_energy += r.decomposed_energy;
    }
    for (const cid in byContract) {
      const hourly = [];
      for (let h = 0; h < 24; h++) {
        const r = results.find(x => x.contract_id === cid && x.hour === h);
        hourly.push({ hour: h, decomposed_energy: r ? r.decomposed_energy : 0 });
      }
      byContract[cid].hourly = hourly;
    }
    return Object.values(byContract);
  }

  if (dimension === 'participant') {
    const byPart = {};
    for (const r of results) {
      if (!byPart[r.buyer_id]) {
        byPart[r.buyer_id] = {
          participant_id: r.buyer_id, code: r.buyer_code, name: r.buyer_name,
          role: 'buyer', total_energy: 0, hourly: new Array(24).fill(0)
        };
      }
      if (!byPart[r.seller_id]) {
        byPart[r.seller_id] = {
          participant_id: r.seller_id, code: r.seller_code, name: r.seller_name,
          role: 'seller', total_energy: 0, hourly: new Array(24).fill(0)
        };
      }
      byPart[r.buyer_id].total_energy += r.decomposed_energy;
      byPart[r.buyer_id].hourly[r.hour] += r.decomposed_energy;
      byPart[r.seller_id].total_energy += r.decomposed_energy;
      byPart[r.seller_id].hourly[r.hour] += r.decomposed_energy;
    }
    return Object.values(byPart).map(p => ({
      ...p,
      hourly: p.hourly.map((e, h) => ({ hour: h, decomposed_energy: e }))
    }));
  }

  throw new Error('维度参数必须是 contract、participant 或 hour');
}

function getContractPerformance(contractId) {
  const contract = getContractById(contractId);
  if (!contract) throw new Error('合约不存在');

  const endDate = contract.termination_date || contract.end_date;

  const decomposedRows = db.prepare(`
    SELECT trade_date, hour, decomposed_energy
    FROM contract_decomposition_results
    WHERE contract_id = ?
    ORDER BY trade_date, hour
  `).all(contractId);

  let totalDecomposed = 0;
  for (const r of decomposedRows) totalDecomposed += r.decomposed_energy;

  const actualMap = {};
  const dates = [...new Set(decomposedRows.map(r => r.trade_date))];
  if (dates.length > 0) {
    const datePlaceholders = dates.map(() => '?').join(',');
    const sellerActuals = db.prepare(`
      SELECT av.participant_id, td.trade_date, av.hour, av.actual_volume
      FROM actual_volumes av
      JOIN trading_days td ON av.trading_day_id = td.id
      WHERE av.participant_id = ? AND td.trade_date IN (${datePlaceholders})
    `).all(contract.seller_id, ...dates);

    for (const a of sellerActuals) {
      const key = `${a.trade_date}_${a.hour}`;
      actualMap[key] = (actualMap[key] || 0) + a.actual_volume;
    }
  }

  let totalActual = 0;
  for (const r of decomposedRows) {
    const key = `${r.trade_date}_${r.hour}`;
    const alloc = r.decomposed_energy;
    const actual = actualMap[key] || 0;
    totalActual += Math.min(actual, alloc);
  }

  const performanceRate = totalDecomposed > 0 ? totalActual / totalDecomposed : 0;

  const monthlyStats = [];
  const monthMap = {};
  for (const r of decomposedRows) {
    const ym = r.trade_date.substring(0, 7);
    if (!monthMap[ym]) monthMap[ym] = { decomposed: 0, actual: 0 };
    monthMap[ym].decomposed += r.decomposed_energy;
    const key = `${r.trade_date}_${r.hour}`;
    const actual = actualMap[key] || 0;
    monthMap[ym].actual += Math.min(actual, r.decomposed_energy);
  }
  for (const ym in monthMap) {
    const m = monthMap[ym];
    const rate = m.decomposed > 0 ? m.actual / m.decomposed : 0;
    monthlyStats.push({
      month: ym,
      decomposed_energy: m.decomposed,
      actual_delivery: m.actual,
      performance_rate: rate,
      status: rate < 0.9 ? 'under_performed' : 'normal'
    });
  }

  return {
    contract: {
      id: contract.id,
      contract_no: contract.contract_no,
      buyer: contract.buyer,
      seller: contract.seller,
      start_date: contract.start_date,
      end_date: endDate,
      total_energy: contract.total_energy,
      contract_price: contract.contract_price,
      status: contract.status
    },
    summary: {
      total_decomposed: totalDecomposed,
      total_actual_delivery: totalActual,
      performance_rate: performanceRate,
      overall_status: performanceRate < 0.9 ? 'under_performed' : 'normal'
    },
    monthly_stats: monthlyStats
  };
}

function getParticipantContractsPerformance(participantId) {
  const p = getParticipantById(participantId);
  if (!p) throw new Error('市场主体不存在');

  const contracts = listContracts({ participant_id: participantId });
  const results = [];

  for (const c of contracts) {
    const perf = getContractPerformance(c.id);
    results.push({
      contract_id: c.id,
      contract_no: c.contract_no,
      counterparty: p.id === c.buyer_id ? c.seller : c.buyer,
      role: p.id === c.buyer_id ? 'buyer' : 'seller',
      ...perf.summary
    });
  }

  const totalDecomposed = results.reduce((s, r) => s + r.total_decomposed, 0);
  const totalActual = results.reduce((s, r) => s + r.total_actual_delivery, 0);

  return {
    participant: { id: p.id, code: p.code, name: p.name, type: p.type },
    summary: {
      contract_count: results.length,
      total_decomposed: totalDecomposed,
      total_actual_delivery: totalActual,
      overall_performance_rate: totalDecomposed > 0 ? totalActual / totalDecomposed : 0,
      under_performed_count: results.filter(r => r.overall_status === 'under_performed').length
    },
    contracts: results
  };
}

module.exports = {
  createContract,
  getContractById,
  getContractByNo,
  listContracts,
  terminateContract,
  decomposeContractsForDate,
  getDecompositionByDate,
  getDecompositionByTradingDay,
  getDecompositionAggregated,
  getContractPerformance,
  getParticipantContractsPerformance
};
