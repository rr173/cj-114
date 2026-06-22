const { v4: uuidv4 } = require('uuid');
const db = require('../utils/db');

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

function getMonthDays(monthStr) {
  const [year, month] = monthStr.split('-').map(Number);
  return new Date(year, month, 0).getDate();
}

function _collectSpotMarketData(monthStr) {
  const tradingDays = db.prepare(`
    SELECT td.id, td.trade_date, td.status
    FROM trading_days td
    WHERE strftime('%Y-%m', td.trade_date) = ?
      AND td.status IN ('cleared', 'settled')
    ORDER BY td.trade_date
  `).all(monthStr);

  if (tradingDays.length === 0) {
    return {
      cleared_trading_days: 0,
      average_clearing_price: 0,
      highest_price_period: null,
      lowest_price_period: null,
      total_traded_energy: 0,
      zonal_clearing_days_ratio: 0,
      daily_details: []
    };
  }

  const dayIds = tradingDays.map(td => td.id);
  const clearingResults = db.prepare(`
    SELECT cr.trading_day_id, cr.hour, cr.clearing_price, cr.clearing_volume, cr.clearing_type,
           td.trade_date
    FROM clearing_results cr
    JOIN trading_days td ON cr.trading_day_id = td.id
    WHERE cr.trading_day_id IN (${dayIds.map(() => '?').join(', ')})
    ORDER BY td.trade_date, cr.hour
  `).all(...dayIds);

  const generatorAllocations = db.prepare(`
    SELECT ca.clearing_result_id, ca.participant_id, ca.final_dispatch,
           cr.trading_day_id, cr.hour, p.type
    FROM clearing_allocations ca
    JOIN clearing_results cr ON ca.clearing_result_id = cr.id
    JOIN market_participants p ON ca.participant_id = p.id
    WHERE cr.trading_day_id IN (${dayIds.map(() => '?').join(', ')})
      AND p.type = 'generator'
  `).all(...dayIds);

  const genAllocMap = {};
  for (const ga of generatorAllocations) {
    const key = `${ga.trading_day_id}_${ga.hour}`;
    if (!genAllocMap[key]) genAllocMap[key] = 0;
    genAllocMap[key] += ga.final_dispatch;
  }

  let totalPrice = 0;
  let priceCount = 0;
  let highestPrice = -Infinity;
  let lowestPrice = Infinity;
  let highestPricePeriod = null;
  let lowestPricePeriod = null;
  let totalEnergy = 0;
  let zonalClearingDays = 0;

  const dailyData = {};
  for (const td of tradingDays) {
    dailyData[td.id] = {
      trade_date: td.trade_date,
      avg_price: 0,
      total_energy: 0,
      has_zonal_clearing: false,
      hourly_prices: []
    };
  }

  for (const cr of clearingResults) {
    const key = `${cr.trading_day_id}_${cr.hour}`;
    const genVolume = genAllocMap[key] || 0;

    totalPrice += cr.clearing_price;
    priceCount++;
    totalEnergy += genVolume;

    if (cr.clearing_price > highestPrice) {
      highestPrice = cr.clearing_price;
      highestPricePeriod = {
        trade_date: cr.trade_date,
        hour: cr.hour,
        price: cr.clearing_price
      };
    }
    if (cr.clearing_price < lowestPrice) {
      lowestPrice = cr.clearing_price;
      lowestPricePeriod = {
        trade_date: cr.trade_date,
        hour: cr.hour,
        price: cr.clearing_price
      };
    }

    if (cr.clearing_type === 'zoned') {
      dailyData[cr.trading_day_id].has_zonal_clearing = true;
    }

    dailyData[cr.trading_day_id].avg_price += cr.clearing_price;
    dailyData[cr.trading_day_id].total_energy += genVolume;
    dailyData[cr.trading_day_id].hourly_prices.push({
      hour: cr.hour,
      price: cr.clearing_price,
      volume: genVolume
    });
  }

  const dailyDetails = Object.values(dailyData).map(d => ({
    ...d,
    avg_price: d.hourly_prices.length > 0 ? d.avg_price / d.hourly_prices.length : 0
  }));

  zonalClearingDays = dailyDetails.filter(d => d.has_zonal_clearing).length;

  return {
    cleared_trading_days: tradingDays.length,
    average_clearing_price: priceCount > 0 ? Math.round(totalPrice / priceCount * 100) / 100 : 0,
    highest_price_period: highestPricePeriod,
    lowest_price_period: lowestPricePeriod,
    total_traded_energy: Math.round(totalEnergy * 100) / 100,
    zonal_clearing_days_ratio: tradingDays.length > 0 ? Math.round(zonalClearingDays / tradingDays.length * 10000) / 10000 : 0,
    daily_details: dailyDetails
  };
}

function _collectContractData(monthStr) {
  const monthStart = monthStr + '-01';
  const monthEnd = monthStr + '-' + getMonthDays(monthStr).toString().padStart(2, '0');

  const activeContracts = db.prepare(`
    SELECT c.*, 
           bc.code as buyer_code, bc.name as buyer_name,
           sc.code as seller_code, sc.name as seller_name
    FROM mid_long_term_contracts c
    JOIN market_participants bc ON c.buyer_id = bc.id
    JOIN market_participants sc ON c.seller_id = sc.id
    WHERE c.status = 'active'
      AND c.start_date <= ?
      AND COALESCE(c.termination_date, c.end_date) >= ?
  `).all(monthEnd, monthStart);

  const contractIds = activeContracts.map(c => c.id);
  let totalSignedEnergy = 0;
  for (const c of activeContracts) {
    totalSignedEnergy += c.total_energy;
  }

  let totalDecomposedEnergy = 0;
  let contractPerformanceSum = 0;
  let contractPerformanceCount = 0;

  if (contractIds.length > 0) {
    const decompositionResults = db.prepare(`
      SELECT dr.contract_id, dr.trade_date, dr.hour, dr.decomposed_energy,
             dr.buyer_id, dr.seller_id
      FROM contract_decomposition_results dr
      WHERE strftime('%Y-%m', dr.trade_date) = ?
        AND dr.contract_id IN (${contractIds.map(() => '?').join(', ')})
    `).all(monthStr, ...contractIds);

    for (const dr of decompositionResults) {
      totalDecomposedEnergy += dr.decomposed_energy;
    }

    const actualVolumes = db.prepare(`
      SELECT av.participant_id, av.hour, av.actual_volume, td.trade_date
      FROM actual_volumes av
      JOIN trading_days td ON av.trading_day_id = td.id
      WHERE strftime('%Y-%m', td.trade_date) = ?
    `).all(monthStr);

    const actualMap = {};
    for (const av of actualVolumes) {
      const key = `${av.participant_id}_${av.trade_date}_${av.hour}`;
      actualMap[key] = av.actual_volume;
    }

    const contractMonthMap = {};
    for (const dr of decompositionResults) {
      const cid = dr.contract_id;
      if (!contractMonthMap[cid]) {
        contractMonthMap[cid] = { decomposed: 0, actual: 0 };
      }
      contractMonthMap[cid].decomposed += dr.decomposed_energy;

      const actualKey = `${dr.seller_id}_${dr.trade_date}_${dr.hour}`;
      const actual = actualMap[actualKey] || 0;
      contractMonthMap[cid].actual += Math.min(actual, dr.decomposed_energy);
    }

    for (const cid in contractMonthMap) {
      const cm = contractMonthMap[cid];
      if (cm.decomposed > 0) {
        contractPerformanceSum += cm.actual / cm.decomposed;
        contractPerformanceCount++;
      }
    }
  }

  return {
    active_contract_count: activeContracts.length,
    total_signed_energy: Math.round(totalSignedEnergy * 100) / 100,
    monthly_decomposed_energy: Math.round(totalDecomposedEnergy * 100) / 100,
    average_performance_rate: contractPerformanceCount > 0
      ? Math.round(contractPerformanceSum / contractPerformanceCount * 10000) / 10000
      : 0,
    contract_details: activeContracts.map(c => ({
      contract_id: c.id,
      contract_no: c.contract_no,
      buyer: { id: c.buyer_id, code: c.buyer_code, name: c.buyer_name },
      seller: { id: c.seller_id, code: c.seller_code, name: c.seller_name },
      start_date: c.start_date,
      end_date: c.end_date,
      total_energy: c.total_energy,
      contract_price: c.contract_price,
      decomposition_method: c.decomposition_method
    }))
  };
}

function _collectAncillaryServiceData(monthStr) {
  const tradingDays = db.prepare(`
    SELECT td.id, td.trade_date
    FROM trading_days td
    WHERE strftime('%Y-%m', td.trade_date) = ?
      AND td.status IN ('cleared', 'settled')
    ORDER BY td.trade_date
  `).all(monthStr);

  let totalFrequencyCapacity = 0;
  let totalReserveCapacity = 0;
  let totalAncillaryFee = 0;

  if (tradingDays.length > 0) {
    const dayIds = tradingDays.map(td => td.id);
    const ancillaryClearing = db.prepare(`
      SELECT acr.service_type, acr.total_cleared_capacity, acr.clearing_price,
             aca.participant_id, aca.hour, aca.cleared_capacity
      FROM ancillary_clearing_results acr
      JOIN ancillary_clearing_allocations aca ON acr.id = aca.clearing_result_id
      WHERE acr.trading_day_id IN (${dayIds.map(() => '?').join(', ')})
    `).all(...dayIds);

    for (const ac of ancillaryClearing) {
      if (ac.service_type === 'frequency') {
        totalFrequencyCapacity += ac.cleared_capacity;
      } else if (ac.service_type === 'reserve') {
        totalReserveCapacity += ac.cleared_capacity;
      }
    }

    const ancillarySettlements = db.prepare(`
      SELECT ass.*, p.code, p.name
      FROM ancillary_service_settlements ass
      JOIN market_participants p ON ass.participant_id = p.id
      WHERE ass.month = ?
    `).all(monthStr);

    for (const s of ancillarySettlements) {
      totalAncillaryFee += s.total_fee;
    }

    const settlementDetails = db.prepare(`
      SELECT sd.participant_id, SUM(sd.amount) as total_income, p.code, p.name
      FROM settlement_details sd
      JOIN trading_days td ON sd.trading_day_id = td.id
      JOIN market_participants p ON sd.participant_id = p.id
      WHERE strftime('%Y-%m', td.trade_date) = ?
        AND p.type = 'generator'
      GROUP BY sd.participant_id
    `).all(monthStr);

    const generatorIncomeMap = {};
    for (const sd of settlementDetails) {
      generatorIncomeMap[sd.participant_id] = Math.abs(sd.total_income);
    }

    const generatorAncillaryMap = {};
    for (const s of ancillarySettlements) {
      if (!generatorAncillaryMap[s.participant_id]) {
        generatorAncillaryMap[s.participant_id] = {
          participant_id: s.participant_id,
          code: s.code,
          name: s.name,
          ancillary_fee: 0,
          total_income: 0,
          ratio: 0
        };
      }
      generatorAncillaryMap[s.participant_id].ancillary_fee += s.total_fee;
    }

    for (const pid in generatorAncillaryMap) {
      const item = generatorAncillaryMap[pid];
      item.total_income = generatorIncomeMap[pid] || 0;
      if (item.total_income > 0) {
        item.ratio = Math.round(item.ancillary_fee / item.total_income * 10000) / 10000;
      }
    }

    const top3Ratio = Object.values(generatorAncillaryMap)
      .filter(g => g.total_income > 0)
      .sort((a, b) => b.ratio - a.ratio)
      .slice(0, 3);

    return {
      total_frequency_capacity: Math.round(totalFrequencyCapacity * 100) / 100,
      total_reserve_capacity: Math.round(totalReserveCapacity * 100) / 100,
      total_ancillary_fee: Math.round(totalAncillaryFee * 100) / 100,
      top3_ancillary_ratio: top3Ratio
    };
  }

  return {
    total_frequency_capacity: 0,
    total_reserve_capacity: 0,
    total_ancillary_fee: 0,
    top3_ancillary_ratio: []
  };
}

function _collectIntradayData(monthStr) {
  const tradingDays = db.prepare(`
    SELECT td.id, td.trade_date
    FROM trading_days td
    WHERE strftime('%Y-%m', td.trade_date) = ?
      AND td.status IN ('cleared', 'settled')
    ORDER BY td.trade_date
  `).all(monthStr);

  let totalTradeCount = 0;
  let totalTradeQuantity = 0;
  let totalIntradayAmount = 0;

  if (tradingDays.length > 0) {
    const dayIds = tradingDays.map(td => td.id);
    const intradayTrades = db.prepare(`
      SELECT it.trade_quantity, it.trade_price, it.trading_day_id, it.hour
      FROM intraday_trades it
      WHERE it.trading_day_id IN (${dayIds.map(() => '?').join(', ')})
    `).all(...dayIds);

    totalTradeCount = intradayTrades.length;
    for (const t of intradayTrades) {
      totalTradeQuantity += t.trade_quantity;
      totalIntradayAmount += t.trade_quantity * t.trade_price;
    }

    const dayAheadPrices = db.prepare(`
      SELECT cr.trading_day_id, cr.hour, cr.clearing_price
      FROM clearing_results cr
      WHERE cr.trading_day_id IN (${dayIds.map(() => '?').join(', ')})
    `).all(...dayIds);

    const dayAheadPriceMap = {};
    for (const dp of dayAheadPrices) {
      const key = `${dp.trading_day_id}_${dp.hour}`;
      dayAheadPriceMap[key] = dp.clearing_price;
    }

    let weightedIntradayPrice = 0;
    let weightedDayAheadPrice = 0;
    let totalWeight = 0;

    for (const t of intradayTrades) {
      const key = `${t.trading_day_id}_${t.hour}`;
      const dayAheadPrice = dayAheadPriceMap[key] || 0;
      if (dayAheadPrice > 0) {
        weightedIntradayPrice += t.trade_price * t.trade_quantity;
        weightedDayAheadPrice += dayAheadPrice * t.trade_quantity;
        totalWeight += t.trade_quantity;
      }
    }

    const avgIntradayPrice = totalWeight > 0 ? weightedIntradayPrice / totalWeight : 0;
    const avgDayAheadPrice = totalWeight > 0 ? weightedDayAheadPrice / totalWeight : 0;
    const priceDeviationPercent = avgDayAheadPrice > 0
      ? Math.round((avgIntradayPrice - avgDayAheadPrice) / avgDayAheadPrice * 10000) / 100
      : 0;

    return {
      total_trade_count: totalTradeCount,
      total_traded_energy: Math.round(totalTradeQuantity * 100) / 100,
      weighted_average_intraday_price: Math.round(avgIntradayPrice * 100) / 100,
      weighted_average_dayahead_price: Math.round(avgDayAheadPrice * 100) / 100,
      price_deviation_percent: priceDeviationPercent
    };
  }

  return {
    total_trade_count: 0,
    total_traded_energy: 0,
    weighted_average_intraday_price: 0,
    weighted_average_dayahead_price: 0,
    price_deviation_percent: 0
  };
}

function _collectGreenCertificateData(monthStr) {
  const [year, month] = monthStr.split('-').map(Number);

  const newCertificates = db.prepare(`
    SELECT COALESCE(SUM(gc.quantity), 0) as total
    FROM green_certificates gc
    WHERE strftime('%Y-%m', gc.trade_date) = ?
      AND gc.source = 'auto_issue'
  `).get(monthStr).total;

  const tradingSessions = db.prepare(`
    SELECT id FROM gc_trading_sessions WHERE year = ? AND month = ?
  `).all(year, month);

  let totalTradedQuantity = 0;
  let totalTradedAmount = 0;
  if (tradingSessions.length > 0) {
    const sessionIds = tradingSessions.map(s => s.id);
    const trades = db.prepare(`
      SELECT trade_quantity, trade_price, total_amount
      FROM gc_trades
      WHERE session_id IN (${sessionIds.map(() => '?').join(', ')})
    `).all(...sessionIds);

    for (const t of trades) {
      totalTradedQuantity += t.trade_quantity;
      totalTradedAmount += t.total_amount;
    }
  }

  const consumers = db.prepare(`
    SELECT id FROM market_participants WHERE type = 'consumer'
  `).all();

  let totalCompletionRate = 0;
  let completionRateCount = 0;

  const quotaSetting = db.prepare(`
    SELECT quota_ratio FROM gc_quota_settings WHERE year = ?
  `).get(year);

  if (quotaSetting && consumers.length > 0) {
    const consumerIds = consumers.map(c => c.id);

    const purchaseData = db.prepare(`
      SELECT ca.participant_id, COALESCE(SUM(ca.final_dispatch), 0) as total_purchase
      FROM clearing_allocations ca
      JOIN clearing_results cr ON ca.clearing_result_id = cr.id
      JOIN trading_days td ON cr.trading_day_id = td.id
      WHERE ca.participant_id IN (${consumerIds.map(() => '?').join(', ')})
        AND strftime('%Y', td.trade_date) = ?
      GROUP BY ca.participant_id
    `).all(...consumerIds, year.toString());

    const obtainedData = db.prepare(`
      SELECT gc.owner_id, COALESCE(SUM(gc.quantity), 0) as total_obtained
      FROM green_certificates gc
      WHERE gc.owner_id IN (${consumerIds.map(() => '?').join(', ')})
        AND strftime('%Y', gc.trade_date) = ?
        AND gc.status IN ('transferred', 'traded', 'used')
      GROUP BY gc.owner_id
    `).all(...consumerIds, year.toString());

    const purchaseMap = {};
    const obtainedMap = {};

    for (const p of purchaseData) purchaseMap[p.participant_id] = p.total_purchase;
    for (const o of obtainedData) obtainedMap[o.owner_id] = o.total_obtained;

    for (const cid of consumerIds) {
      const purchase = purchaseMap[cid] || 0;
      const obtained = obtainedMap[cid] || 0;
      const required = Math.ceil(purchase * quotaSetting.quota_ratio);
      if (required > 0) {
        totalCompletionRate += obtained / required;
        completionRateCount++;
      }
    }
  }

  return {
    new_certificate_count: Math.round(newCertificates),
    trading_volume: Math.round(totalTradedQuantity),
    trading_amount: Math.round(totalTradedAmount * 100) / 100,
    average_quota_completion_rate: completionRateCount > 0
      ? Math.round(totalCompletionRate / completionRateCount * 10000) / 10000
      : 0
  };
}

function _collectCreditMarginData(monthStr) {
  let creditScores = db.prepare(`
    SELECT cs.*, p.code, p.name, p.type
    FROM credit_scores cs
    JOIN market_participants p ON cs.participant_id = p.id
    WHERE cs.month = ?
    ORDER BY cs.level, cs.score DESC
  `).all(monthStr);

  if (creditScores.length === 0) {
    creditScores = db.prepare(`
      SELECT cs.*, p.code, p.name, p.type
      FROM credit_scores cs
      JOIN market_participants p ON cs.participant_id = p.id
      WHERE cs.month = (SELECT MAX(month) FROM credit_scores)
      ORDER BY cs.level, cs.score DESC
    `).all();
  }

  const levelDistribution = {
    AAA: 0,
    AA: 0,
    A: 0,
    B: 0
  };

  const lowCreditSubjects = [];
  for (const cs of creditScores) {
    if (levelDistribution[cs.level] != null) {
      levelDistribution[cs.level]++;
    }
    if (cs.score < 60) {
      lowCreditSubjects.push({
        participant_id: cs.participant_id,
        code: cs.code,
        name: cs.name,
        type: cs.type,
        score: cs.score,
        level: cs.level,
        trading_restricted: cs.trading_restricted === 1
      });
    }
  }

  const marginAccounts = db.prepare(`
    SELECT SUM(frozen_amount) as total_frozen
    FROM credit_margin_accounts
  `).get();

  const marginTransactions = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total_penalty
    FROM credit_margin_transactions
    WHERE transaction_type = 'penalty'
      AND strftime('%Y-%m', created_at) = ?
  `).all(monthStr);

  const totalPenalty = marginTransactions[0]?.total_penalty || 0;

  return {
    level_distribution: levelDistribution,
    total_margin_frozen: Math.round(marginAccounts.total_frozen * 100) / 100,
    monthly_penalty_total: Math.round(totalPenalty * 100) / 100,
    low_credit_subjects: lowCreditSubjects
  };
}

function generateMonthlyReport(monthStr) {
  if (!MONTH_PATTERN.test(monthStr)) {
    throw new Error('月份格式应为 YYYY-MM');
  }

  const spotMarketData = _collectSpotMarketData(monthStr);
  const contractData = _collectContractData(monthStr);
  const ancillaryServiceData = _collectAncillaryServiceData(monthStr);
  const intradayData = _collectIntradayData(monthStr);
  const greenCertificateData = _collectGreenCertificateData(monthStr);
  const creditMarginData = _collectCreditMarginData(monthStr);

  const summaryData = {
    month: monthStr,
    total_cleared_days: spotMarketData.cleared_trading_days,
    total_spot_energy: spotMarketData.total_traded_energy,
    avg_spot_price: spotMarketData.average_clearing_price,
    total_contract_energy: contractData.monthly_decomposed_energy,
    total_intraday_trades: intradayData.total_trade_count,
    total_intraday_energy: intradayData.total_traded_energy,
    total_ancillary_fee: ancillaryServiceData.total_ancillary_fee,
    new_green_certificates: greenCertificateData.new_certificate_count,
    generated_at: new Date().toISOString()
  };

  const tx = db.transaction(() => {
    const existing = db.prepare('SELECT id FROM monthly_market_reports WHERE month = ?').get(monthStr);
    const id = existing?.id || uuidv4();

    if (existing) {
      db.prepare(`
        UPDATE monthly_market_reports SET
          spot_market_data = ?,
          contract_data = ?,
          ancillary_service_data = ?,
          intraday_data = ?,
          green_certificate_data = ?,
          credit_margin_data = ?,
          summary_data = ?,
          status = 'final',
          generated_at = datetime('now'),
          updated_at = datetime('now')
        WHERE month = ?
      `).run(
        JSON.stringify(spotMarketData),
        JSON.stringify(contractData),
        JSON.stringify(ancillaryServiceData),
        JSON.stringify(intradayData),
        JSON.stringify(greenCertificateData),
        JSON.stringify(creditMarginData),
        JSON.stringify(summaryData),
        monthStr
      );
    } else {
      db.prepare(`
        INSERT INTO monthly_market_reports
        (id, month, status, spot_market_data, contract_data, ancillary_service_data,
         intraday_data, green_certificate_data, credit_margin_data, summary_data)
        VALUES (?, ?, 'final', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        monthStr,
        JSON.stringify(spotMarketData),
        JSON.stringify(contractData),
        JSON.stringify(ancillaryServiceData),
        JSON.stringify(intradayData),
        JSON.stringify(greenCertificateData),
        JSON.stringify(creditMarginData),
        JSON.stringify(summaryData)
      );
    }

    return getReportByMonth(monthStr);
  });

  return tx();
}

function getReportByMonth(monthStr) {
  if (!MONTH_PATTERN.test(monthStr)) {
    throw new Error('月份格式应为 YYYY-MM');
  }

  const row = db.prepare('SELECT * FROM monthly_market_reports WHERE month = ?').get(monthStr);
  if (!row) return null;

  return {
    id: row.id,
    month: row.month,
    generated_at: row.generated_at,
    status: row.status,
    spot_market: row.spot_market_data ? JSON.parse(row.spot_market_data) : null,
    contracts: row.contract_data ? JSON.parse(row.contract_data) : null,
    ancillary_services: row.ancillary_service_data ? JSON.parse(row.ancillary_service_data) : null,
    intraday: row.intraday_data ? JSON.parse(row.intraday_data) : null,
    green_certificates: row.green_certificate_data ? JSON.parse(row.green_certificate_data) : null,
    credit_margin: row.credit_margin_data ? JSON.parse(row.credit_margin_data) : null,
    summary: row.summary_data ? JSON.parse(row.summary_data) : null,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function listReports(limit = 50, offset = 0) {
  const rows = db.prepare(`
    SELECT * FROM monthly_market_reports
    ORDER BY month DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);

  return rows.map(row => ({
    id: row.id,
    month: row.month,
    generated_at: row.generated_at,
    status: row.status,
    summary: row.summary_data ? JSON.parse(row.summary_data) : null,
    created_at: row.created_at,
    updated_at: row.updated_at
  }));
}

function _calculateChange(oldVal, newVal) {
  const change = newVal - oldVal;
  let changePercent = 0;
  if (oldVal !== 0 && oldVal != null) {
    changePercent = Math.round(change / oldVal * 10000) / 100;
  } else if (newVal > 0) {
    changePercent = null;
  }
  return {
    old_value: oldVal,
    new_value: newVal,
    change: Math.round(change * 100) / 100,
    change_percent: changePercent
  };
}

function compareReports(month1, month2) {
  const report1 = getReportByMonth(month1);
  const report2 = getReportByMonth(month2);

  if (!report1) throw new Error(`${month1} 的报告不存在`);
  if (!report2) throw new Error(`${month2} 的报告不存在`);

  const comparison = {
    base_month: month1,
    compare_month: month2,
    generated_at: new Date().toISOString(),
    sections: {}
  };

  if (report1.spot_market && report2.spot_market) {
    comparison.sections.spot_market = {
      cleared_trading_days: _calculateChange(
        report1.spot_market.cleared_trading_days,
        report2.spot_market.cleared_trading_days
      ),
      average_clearing_price: _calculateChange(
        report1.spot_market.average_clearing_price,
        report2.spot_market.average_clearing_price
      ),
      total_traded_energy: _calculateChange(
        report1.spot_market.total_traded_energy,
        report2.spot_market.total_traded_energy
      ),
      zonal_clearing_days_ratio: _calculateChange(
        report1.spot_market.zonal_clearing_days_ratio,
        report2.spot_market.zonal_clearing_days_ratio
      )
    };
  }

  if (report1.contracts && report2.contracts) {
    comparison.sections.contracts = {
      active_contract_count: _calculateChange(
        report1.contracts.active_contract_count,
        report2.contracts.active_contract_count
      ),
      total_signed_energy: _calculateChange(
        report1.contracts.total_signed_energy,
        report2.contracts.total_signed_energy
      ),
      monthly_decomposed_energy: _calculateChange(
        report1.contracts.monthly_decomposed_energy,
        report2.contracts.monthly_decomposed_energy
      ),
      average_performance_rate: _calculateChange(
        report1.contracts.average_performance_rate,
        report2.contracts.average_performance_rate
      )
    };
  }

  if (report1.ancillary_services && report2.ancillary_services) {
    comparison.sections.ancillary_services = {
      total_frequency_capacity: _calculateChange(
        report1.ancillary_services.total_frequency_capacity,
        report2.ancillary_services.total_frequency_capacity
      ),
      total_reserve_capacity: _calculateChange(
        report1.ancillary_services.total_reserve_capacity,
        report2.ancillary_services.total_reserve_capacity
      ),
      total_ancillary_fee: _calculateChange(
        report1.ancillary_services.total_ancillary_fee,
        report2.ancillary_services.total_ancillary_fee
      )
    };
  }

  if (report1.intraday && report2.intraday) {
    comparison.sections.intraday = {
      total_trade_count: _calculateChange(
        report1.intraday.total_trade_count,
        report2.intraday.total_trade_count
      ),
      total_traded_energy: _calculateChange(
        report1.intraday.total_traded_energy,
        report2.intraday.total_traded_energy
      ),
      weighted_average_intraday_price: _calculateChange(
        report1.intraday.weighted_average_intraday_price,
        report2.intraday.weighted_average_intraday_price
      ),
      price_deviation_percent: _calculateChange(
        report1.intraday.price_deviation_percent,
        report2.intraday.price_deviation_percent
      )
    };
  }

  if (report1.green_certificates && report2.green_certificates) {
    comparison.sections.green_certificates = {
      new_certificate_count: _calculateChange(
        report1.green_certificates.new_certificate_count,
        report2.green_certificates.new_certificate_count
      ),
      trading_volume: _calculateChange(
        report1.green_certificates.trading_volume,
        report2.green_certificates.trading_volume
      ),
      average_quota_completion_rate: _calculateChange(
        report1.green_certificates.average_quota_completion_rate,
        report2.green_certificates.average_quota_completion_rate
      )
    };
  }

  if (report1.credit_margin && report2.credit_margin) {
    comparison.sections.credit_margin = {
      level_distribution_changes: {
        AAA: _calculateChange(
          report1.credit_margin.level_distribution.AAA,
          report2.credit_margin.level_distribution.AAA
        ),
        AA: _calculateChange(
          report1.credit_margin.level_distribution.AA,
          report2.credit_margin.level_distribution.AA
        ),
        A: _calculateChange(
          report1.credit_margin.level_distribution.A,
          report2.credit_margin.level_distribution.A
        ),
        B: _calculateChange(
          report1.credit_margin.level_distribution.B,
          report2.credit_margin.level_distribution.B
        )
      },
      total_margin_frozen: _calculateChange(
        report1.credit_margin.total_margin_frozen,
        report2.credit_margin.total_margin_frozen
      ),
      monthly_penalty_total: _calculateChange(
        report1.credit_margin.monthly_penalty_total,
        report2.credit_margin.monthly_penalty_total
      ),
      low_credit_subject_count: _calculateChange(
        report1.credit_margin.low_credit_subjects.length,
        report2.credit_margin.low_credit_subjects.length
      )
    };
  }

  return comparison;
}

function deleteReport(monthStr) {
  if (!MONTH_PATTERN.test(monthStr)) {
    throw new Error('月份格式应为 YYYY-MM');
  }

  const result = db.prepare('DELETE FROM monthly_market_reports WHERE month = ?').run(monthStr);
  return result.changes > 0;
}

module.exports = {
  generateMonthlyReport,
  getReportByMonth,
  listReports,
  compareReports,
  deleteReport
};
