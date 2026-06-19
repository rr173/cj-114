const { v4: uuidv4 } = require('uuid');
const db = require('../utils/db');
const { isRenewableGenerator, getParticipantById, listParticipants, RENEWABLE_ENERGY_TYPES } = require('./participantService');
const { getTradingDayById } = require('./tradingDayService');

function generateCertificateNo(generatorCode, tradeDate, hour, seq) {
  const dateStr = tradeDate.replace(/-/g, '');
  const hourStr = hour.toString().padStart(2, '0');
  const seqStr = seq.toString().padStart(4, '0');
  return `GC-${generatorCode}-${dateStr}-${hourStr}-${seqStr}`;
}

function issueGreenCertificatesForClearing(tradingDayId) {
  const td = getTradingDayById(tradingDayId);
  if (!td) {
    throw new Error('交易日不存在');
  }

  const existing = db.prepare('SELECT COUNT(*) as cnt FROM green_certificates WHERE trading_day_id = ?').get(tradingDayId);
  if (existing.cnt > 0) {
    throw new Error('该交易日已发放过绿证');
  }

  const clearingData = db.prepare(`
    SELECT 
      cr.id as clearing_result_id,
      cr.hour,
      ca.participant_id as generator_id,
      ca.final_dispatch as quantity,
      p.energy_type,
      p.code as generator_code,
      p.name as generator_name
    FROM clearing_results cr
    JOIN clearing_allocations ca ON cr.id = ca.clearing_result_id
    JOIN market_participants p ON ca.participant_id = p.id
    WHERE cr.trading_day_id = ? AND p.type = 'generator'
    ORDER BY cr.hour, p.code
  `).all(tradingDayId);

  const consumerAllocations = db.prepare(`
    SELECT 
      cr.hour,
      ca.participant_id as consumer_id,
      ca.final_dispatch as quantity,
      p.code as consumer_code
    FROM clearing_results cr
    JOIN clearing_allocations ca ON cr.id = ca.clearing_result_id
    JOIN market_participants p ON ca.participant_id = p.id
    WHERE cr.trading_day_id = ? AND p.type = 'consumer'
    ORDER BY cr.hour
  `).all(tradingDayId);

  const tx = db.transaction(() => {
    const insertCert = db.prepare(`
      INSERT INTO green_certificates 
      (id, certificate_no, generator_id, energy_type, trading_day_id, trade_date, hour, quantity, owner_id, status, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertTransfer = db.prepare(`
      INSERT INTO gc_transfer_records
      (id, certificate_id, from_participant_id, to_participant_id, transfer_type, reference_no)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    let totalIssued = 0;
    let totalTransferred = 0;

    const seqCounters = {};

    for (const row of clearingData) {
      if (!row.energy_type || !RENEWABLE_ENERGY_TYPES.includes(row.energy_type)) {
        continue;
      }

      const quantity = Math.floor(row.quantity);
      if (quantity <= 0) continue;

      const counterKey = `${row.generator_id}-${row.hour}`;
      seqCounters[counterKey] = (seqCounters[counterKey] || 0) + 1;

      const certNo = generateCertificateNo(
        row.generator_code,
        td.trade_date,
        row.hour,
        seqCounters[counterKey]
      );

      const certId = uuidv4();
      insertCert.run(
        certId,
        certNo,
        row.generator_id,
        row.energy_type,
        tradingDayId,
        td.trade_date,
        row.hour,
        quantity,
        row.generator_id,
        'available',
        'auto_issue'
      );

      totalIssued += quantity;

      const consumerHourAllocs = consumerAllocations.filter(c => c.hour === row.hour);
      const totalConsumerDemand = consumerHourAllocs.reduce((s, c) => s + c.quantity, 0);

      if (totalConsumerDemand > 0) {
        let remainingToTransfer = quantity;
        for (const consumerAlloc of consumerHourAllocs) {
          if (remainingToTransfer <= 0) break;

          const transferShare = consumerAlloc.quantity / totalConsumerDemand;
          const transferQty = Math.min(remainingToTransfer, Math.floor(quantity * transferShare));

          if (transferQty > 0) {
            const subCertId = uuidv4();
            const subCertNo = certNo + `-${transferQty}`;
            insertCert.run(
              subCertId,
              subCertNo,
              row.generator_id,
              row.energy_type,
              tradingDayId,
              td.trade_date,
              row.hour,
              transferQty,
              consumerAlloc.consumer_id,
              'transferred',
              'auto_issue'
            );

            insertTransfer.run(
              uuidv4(),
              subCertId,
              row.generator_id,
              consumerAlloc.consumer_id,
              'auto_allocation',
              `CLEAR-${tradingDayId}-${row.hour}`
            );

            remainingToTransfer -= transferQty;
            totalTransferred += transferQty;
          }
        }

        if (remainingToTransfer > 0) {
          db.prepare('UPDATE green_certificates SET quantity = ? WHERE id = ?')
            .run(remainingToTransfer, certId);
        } else {
          db.prepare('UPDATE green_certificates SET status = ? WHERE id = ?')
            .run('transferred', certId);
        }
      }
    }

    return { totalIssued, totalTransferred };
  });

  const result = tx();
  return {
    trading_day_id: tradingDayId,
    trade_date: td.trade_date,
    total_certificates_issued: result.totalIssued,
    total_auto_transferred: result.totalTransferred
  };
}

function setAnnualQuota(year, quotaRatio, penaltyPrice) {
  if (!year || year < 2000 || year > 2100) {
    throw new Error('年份无效');
  }
  if (quotaRatio <= 0 || quotaRatio > 1) {
    throw new Error('配额比例必须在0到1之间');
  }
  if (penaltyPrice <= 0) {
    throw new Error('罚款单价必须大于0');
  }

  const existing = db.prepare('SELECT id FROM gc_quota_settings WHERE year = ?').get(year);
  const id = uuidv4();

  if (existing) {
    db.prepare(`
      UPDATE gc_quota_settings 
      SET quota_ratio = ?, penalty_price = ?, created_at = datetime('now')
      WHERE year = ?
    `).run(quotaRatio, penaltyPrice, year);
  } else {
    db.prepare(`
      INSERT INTO gc_quota_settings (id, year, quota_ratio, penalty_price)
      VALUES (?, ?, ?, ?)
    `).run(id, year, quotaRatio, penaltyPrice);
  }

  return getQuotaSetting(year);
}

function getQuotaSetting(year) {
  return db.prepare('SELECT * FROM gc_quota_settings WHERE year = ?').get(year);
}

function listQuotaSettings() {
  return db.prepare('SELECT * FROM gc_quota_settings ORDER BY year DESC').all();
}

function getGeneratorGcAccount(generatorId, year = null) {
  const generator = getParticipantById(generatorId);
  if (!generator || generator.type !== 'generator') {
    throw new Error('电厂不存在');
  }

  let sql = `
    SELECT 
      gc.energy_type,
      gc.status,
      SUM(gc.quantity) as total_quantity,
      COUNT(*) as certificate_count
    FROM green_certificates gc
    WHERE gc.generator_id = ?
  `;
  const params = [generatorId];

  if (year) {
    sql += ` AND strftime('%Y', gc.trade_date) = ?`;
    params.push(year.toString());
  }

  sql += ' GROUP BY gc.energy_type, gc.status ORDER BY gc.energy_type, gc.status';

  const details = db.prepare(sql).all(...params);

  const summary = db.prepare(`
    SELECT 
      SUM(CASE WHEN gc.source = 'auto_issue' THEN gc.quantity ELSE 0 END) as total_issued,
      SUM(CASE WHEN gc.owner_id = ? AND gc.status = 'available' THEN gc.quantity ELSE 0 END) as available,
      SUM(CASE WHEN gc.status = 'transferred' THEN gc.quantity ELSE 0 END) as transferred,
      SUM(CASE WHEN gc.status = 'traded' THEN gc.quantity ELSE 0 END) as traded
    FROM green_certificates gc
    WHERE gc.generator_id = ?
    ${year ? `AND strftime('%Y', gc.trade_date) = ?` : ''}
  `).get(...[generatorId, generatorId, ...(year ? [year.toString()] : [])]);

  return {
    generator,
    year,
    summary: {
      total_issued: summary.total_issued || 0,
      available: summary.available || 0,
      transferred: summary.transferred || 0,
      traded: summary.traded || 0
    },
    details
  };
}

function getConsumerQuotaProgress(consumerId, year) {
  const consumer = getParticipantById(consumerId);
  if (!consumer || consumer.type !== 'consumer') {
    throw new Error('售电公司不存在');
  }

  const quota = getQuotaSetting(year);
  if (!quota) {
    throw new Error(`年度${year}未设置配额比例`);
  }

  const totalPurchase = db.prepare(`
    SELECT COALESCE(SUM(ca.final_dispatch), 0) as total
    FROM clearing_allocations ca
    JOIN clearing_results cr ON ca.clearing_result_id = cr.id
    JOIN trading_days td ON cr.trading_day_id = td.id
    WHERE ca.participant_id = ?
      AND strftime('%Y', td.trade_date) = ?
  `).get(consumerId, year.toString()).total;

  const obtainedGc = db.prepare(`
    SELECT COALESCE(SUM(gc.quantity), 0) as total
    FROM green_certificates gc
    WHERE gc.owner_id = ?
      AND strftime('%Y', gc.trade_date) = ?
      AND gc.status IN ('transferred', 'traded', 'used')
  `).get(consumerId, year.toString()).total;

  const requiredGc = Math.ceil(totalPurchase * quota.quota_ratio);
  const completionRate = totalPurchase > 0 ? obtainedGc / requiredGc : 0;
  const isCompliant = completionRate >= 1;
  const deficit = Math.max(0, requiredGc - obtainedGc);

  return {
    consumer,
    year,
    quota_ratio: quota.quota_ratio,
    penalty_price: quota.penalty_price,
    total_purchase: totalPurchase,
    required_gc: requiredGc,
    obtained_gc: obtainedGc,
    completion_rate: completionRate,
    is_compliant: isCompliant,
    deficit_quantity: deficit,
    estimated_penalty: deficit * quota.penalty_price
  };
}

function createTradingSession(year, month, bidStartTime, bidEndTime) {
  const existing = db.prepare('SELECT id FROM gc_trading_sessions WHERE year = ? AND month = ?').get(year, month);
  if (existing) {
    throw new Error(`年度${year}月度${month}的交易场次已存在`);
  }

  const sessionNo = `GC-TRADE-${year}-${month.toString().padStart(2, '0')}`;
  const id = uuidv4();

  db.prepare(`
    INSERT INTO gc_trading_sessions 
    (id, session_no, year, month, status, bid_start_time, bid_end_time)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, sessionNo, year, month, 'pending', bidStartTime, bidEndTime);

  return getTradingSession(id);
}

function getTradingSession(id) {
  return db.prepare('SELECT * FROM gc_trading_sessions WHERE id = ?').get(id);
}

function getTradingSessionByMonth(year, month) {
  return db.prepare('SELECT * FROM gc_trading_sessions WHERE year = ? AND month = ?').get(year, month);
}

function listTradingSessions(status = null) {
  let sql = 'SELECT * FROM gc_trading_sessions';
  const params = [];
  if (status) {
    sql += ' WHERE status = ?';
    params.push(status);
  }
  sql += ' ORDER BY year DESC, month DESC';
  return db.prepare(sql).all(...params);
}

function updateSessionStatus(sessionId, status) {
  const validStatuses = ['pending', 'bidding', 'completed', 'cancelled'];
  if (!validStatuses.includes(status)) {
    throw new Error(`状态必须是: ${validStatuses.join(', ')}`);
  }

  db.prepare('UPDATE gc_trading_sessions SET status = ? WHERE id = ?').run(status, sessionId);
  return getTradingSession(sessionId);
}

function submitSellOrder(sessionId, sellerId, minPrice, quantity) {
  const session = getTradingSession(sessionId);
  if (!session) throw new Error('交易场次不存在');
  if (session.status !== 'bidding') throw new Error('交易场次不在竞价期');

  const seller = getParticipantById(sellerId);
  if (!seller || seller.type !== 'generator') throw new Error('只有电厂可以卖出绿证');
  if (!isRenewableGenerator(sellerId)) throw new Error('只有可再生能源电厂可以卖绿证');

  const available = db.prepare(`
    SELECT COALESCE(SUM(quantity), 0) as total
    FROM green_certificates 
    WHERE owner_id = ? AND status = 'available'
  `).get(sellerId).total;

  if (available < quantity) {
    throw new Error(`可用绿证不足，当前可用: ${available}张`);
  }

  const id = uuidv4();
  db.prepare(`
    INSERT INTO gc_sell_orders 
    (id, session_id, seller_id, min_price, total_quantity, remaining_quantity, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, sessionId, sellerId, minPrice, quantity, quantity, 'active');

  return getSellOrder(id);
}

function submitBuyOrder(sessionId, buyerId, maxPrice, quantity) {
  const session = getTradingSession(sessionId);
  if (!session) throw new Error('交易场次不存在');
  if (session.status !== 'bidding') throw new Error('交易场次不在竞价期');

  const buyer = getParticipantById(buyerId);
  if (!buyer || buyer.type !== 'consumer') throw new Error('只有售电公司可以购买绿证');

  const id = uuidv4();
  db.prepare(`
    INSERT INTO gc_buy_orders 
    (id, session_id, buyer_id, max_price, demand_quantity, remaining_quantity, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, sessionId, buyerId, maxPrice, quantity, quantity, 'active');

  return getBuyOrder(id);
}

function getSellOrder(id) {
  return db.prepare(`
    SELECT so.*, p.code as seller_code, p.name as seller_name, ts.session_no
    FROM gc_sell_orders so
    JOIN market_participants p ON so.seller_id = p.id
    JOIN gc_trading_sessions ts ON so.session_id = ts.id
    WHERE so.id = ?
  `).get(id);
}

function getBuyOrder(id) {
  return db.prepare(`
    SELECT bo.*, p.code as buyer_code, p.name as buyer_name, ts.session_no
    FROM gc_buy_orders bo
    JOIN market_participants p ON bo.buyer_id = p.id
    JOIN gc_trading_sessions ts ON bo.session_id = ts.id
    WHERE bo.id = ?
  `).get(id);
}

function listSessionOrders(sessionId) {
  const sellOrders = db.prepare(`
    SELECT so.*, p.code as seller_code, p.name as seller_name
    FROM gc_sell_orders so
    JOIN market_participants p ON so.seller_id = p.id
    WHERE so.session_id = ?
    ORDER BY so.min_price ASC, so.created_at ASC
  `).all(sessionId);

  const buyOrders = db.prepare(`
    SELECT bo.*, p.code as buyer_code, p.name as buyer_name
    FROM gc_buy_orders bo
    JOIN market_participants p ON bo.buyer_id = p.id
    WHERE bo.session_id = ?
    ORDER BY bo.max_price DESC, bo.created_at ASC
  `).all(sessionId);

  return { sell_orders: sellOrders, buy_orders: buyOrders };
}

function performMatching(sessionId) {
  const session = getTradingSession(sessionId);
  if (!session) throw new Error('交易场次不存在');
  if (session.status === 'completed') throw new Error('交易场次已完成撮合');

  const tx = db.transaction(() => {
    db.prepare('UPDATE gc_trading_sessions SET status = ? WHERE id = ?').run('completed', sessionId);

    const sellOrders = db.prepare(`
      SELECT * FROM gc_sell_orders 
      WHERE session_id = ? AND status = 'active'
      ORDER BY min_price ASC, created_at ASC
    `).all(sessionId);

    const buyOrders = db.prepare(`
      SELECT * FROM gc_buy_orders 
      WHERE session_id = ? AND status = 'active'
      ORDER BY max_price DESC, created_at ASC
    `).all(sessionId);

    const insertTrade = db.prepare(`
      INSERT INTO gc_trades 
      (id, session_id, sell_order_id, buy_order_id, seller_id, buyer_id, 
       trade_quantity, trade_price, total_amount)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertTransfer = db.prepare(`
      INSERT INTO gc_transfer_records
      (id, certificate_id, from_participant_id, to_participant_id, transfer_type, trade_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const updateCert = db.prepare(`
      UPDATE green_certificates 
      SET owner_id = ?, status = 'traded' 
      WHERE id = ?
    `);

    const updateSellOrder = db.prepare(`
      UPDATE gc_sell_orders SET remaining_quantity = ?, status = ? WHERE id = ?
    `);

    const updateBuyOrder = db.prepare(`
      UPDATE gc_buy_orders SET remaining_quantity = ?, status = ? WHERE id = ?
    `);

    const trades = [];
    let sellIdx = 0, buyIdx = 0;

    while (sellIdx < sellOrders.length && buyIdx < buyOrders.length) {
      const sell = sellOrders[sellIdx];
      const buy = buyOrders[buyIdx];

      if (buy.max_price < sell.min_price) {
        break;
      }

      const tradeQty = Math.min(sell.remaining_quantity, buy.remaining_quantity);
      if (tradeQty <= 0) break;

      const tradePrice = (sell.min_price + buy.max_price) / 2;
      const totalAmount = tradeQty * tradePrice;

      const tradeId = uuidv4();
      insertTrade.run(
        tradeId, sessionId, sell.id, buy.id,
        sell.seller_id, buy.buyer_id,
        tradeQty, tradePrice, totalAmount
      );

      const availableCerts = db.prepare(`
        SELECT * FROM green_certificates 
        WHERE owner_id = ? AND status = 'available'
        ORDER BY created_at ASC
        LIMIT ?
      `).all(sell.seller_id, tradeQty);

      let remainingTransfer = tradeQty;
      for (const cert of availableCerts) {
        if (remainingTransfer <= 0) break;

        const transferQty = Math.min(cert.quantity, remainingTransfer);

        if (transferQty < cert.quantity) {
          const newCertId = uuidv4();
          db.prepare(`
            INSERT INTO green_certificates 
            (id, certificate_no, generator_id, energy_type, trading_day_id, 
             trade_date, hour, quantity, owner_id, status, source)
            SELECT ?, certificate_no || '-SPLIT', generator_id, energy_type, 
                   trading_day_id, trade_date, hour, ?, ?, 'traded', source
            FROM green_certificates WHERE id = ?
          `).run(newCertId, transferQty, buy.buyer_id, cert.id);

          db.prepare('UPDATE green_certificates SET quantity = quantity - ? WHERE id = ?')
            .run(transferQty, cert.id);

          insertTransfer.run(uuidv4(), newCertId, sell.seller_id, buy.buyer_id, 'market_trade', tradeId);
        } else {
          updateCert.run(buy.buyer_id, cert.id);
          insertTransfer.run(uuidv4(), cert.id, sell.seller_id, buy.buyer_id, 'market_trade', tradeId);
        }

        remainingTransfer -= transferQty;
      }

      const sellRemaining = sell.remaining_quantity - tradeQty;
      const buyRemaining = buy.remaining_quantity - tradeQty;

      updateSellOrder.run(
        sellRemaining,
        sellRemaining === 0 ? 'filled' : 'partial',
        sell.id
      );

      updateBuyOrder.run(
        buyRemaining,
        buyRemaining === 0 ? 'filled' : 'partial',
        buy.id
      );

      trades.push({
        trade_id: tradeId,
        seller_id: sell.seller_id,
        buyer_id: buy.buyer_id,
        quantity: tradeQty,
        price: tradePrice,
        amount: totalAmount
      });

      if (sellRemaining === 0) sellIdx++;
      if (buyRemaining === 0) buyIdx++;
    }

    return trades;
  });

  const trades = tx();
  return {
    session_id: sessionId,
    total_trades: trades.length,
    total_quantity: trades.reduce((s, t) => s + t.quantity, 0),
    total_amount: trades.reduce((s, t) => s + t.amount, 0),
    trades
  };
}

function listSessionTrades(sessionId) {
  return db.prepare(`
    SELECT t.*, 
           s.code as seller_code, s.name as seller_name,
           b.code as buyer_code, b.name as buyer_name,
           ts.session_no
    FROM gc_trades t
    JOIN market_participants s ON t.seller_id = s.id
    JOIN market_participants b ON t.buyer_id = b.id
    JOIN gc_trading_sessions ts ON t.session_id = ts.id
    WHERE t.session_id = ?
    ORDER BY t.created_at DESC
  `).all(sessionId);
}

function performAnnualAssessment(year) {
  const quota = getQuotaSetting(year);
  if (!quota) {
    throw new Error(`年度${year}未设置配额比例`);
  }

  const consumers = listParticipants('consumer');

  const tx = db.transaction(() => {
    const results = [];

    for (const consumer of consumers) {
      const progress = getConsumerQuotaProgress(consumer.id, year);

      db.prepare(`
        INSERT OR REPLACE INTO gc_annual_assessments 
        (id, year, participant_id, total_purchase, required_gc, obtained_gc,
         completion_rate, is_compliant, deficit_quantity, penalty_amount)
        VALUES (COALESCE((SELECT id FROM gc_annual_assessments WHERE year = ? AND participant_id = ?), ?),
                ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        year, consumer.id, uuidv4(),
        year, consumer.id,
        progress.total_purchase,
        progress.required_gc,
        progress.obtained_gc,
        progress.completion_rate,
        progress.is_compliant ? 1 : 0,
        progress.deficit_quantity,
        progress.estimated_penalty
      );

      results.push({
        participant_id: consumer.id,
        participant_code: consumer.code,
        participant_name: consumer.name,
        total_purchase: progress.total_purchase,
        required_gc: progress.required_gc,
        obtained_gc: progress.obtained_gc,
        completion_rate: progress.completion_rate,
        is_compliant: progress.is_compliant,
        deficit_quantity: progress.deficit_quantity,
        penalty_amount: progress.estimated_penalty
      });
    }

    return results;
  });

  const results = tx();
  return {
    year,
    quota_ratio: quota.quota_ratio,
    penalty_price: quota.penalty_price,
    total_participants: results.length,
    compliant_count: results.filter(r => r.is_compliant).length,
    total_penalty: results.reduce((s, r) => s + r.penalty_amount, 0),
    results
  };
}

function listAnnualAssessments(year) {
  return db.prepare(`
    SELECT a.*, p.code, p.name, p.type
    FROM gc_annual_assessments a
    JOIN market_participants p ON a.participant_id = p.id
    WHERE a.year = ?
    ORDER BY a.completion_rate DESC
  `).all(year);
}

function listTransferRecords(participantId = null, type = null) {
  let sql = `
    SELECT tr.*,
           from_p.code as from_code, from_p.name as from_name,
           to_p.code as to_code, to_p.name as to_name,
           gc.certificate_no, gc.energy_type, gc.quantity, gc.trade_date, gc.hour
    FROM gc_transfer_records tr
    JOIN market_participants from_p ON tr.from_participant_id = from_p.id
    JOIN market_participants to_p ON tr.to_participant_id = to_p.id
    JOIN green_certificates gc ON tr.certificate_id = gc.id
  `;

  const params = [];
  const conditions = [];

  if (participantId) {
    conditions.push('(tr.from_participant_id = ? OR tr.to_participant_id = ?)');
    params.push(participantId, participantId);
  }

  if (type) {
    conditions.push('tr.transfer_type = ?');
    params.push(type);
  }

  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }

  sql += ' ORDER BY tr.created_at DESC LIMIT 500';

  return db.prepare(sql).all(...params);
}

function listCertificates(ownerId = null, status = null, energyType = null) {
  let sql = `
    SELECT gc.*,
           gen.code as generator_code, gen.name as generator_name,
           owner.code as owner_code, owner.name as owner_name
    FROM green_certificates gc
    JOIN market_participants gen ON gc.generator_id = gen.id
    JOIN market_participants owner ON gc.owner_id = owner.id
  `;

  const params = [];
  const conditions = [];

  if (ownerId) {
    conditions.push('gc.owner_id = ?');
    params.push(ownerId);
  }

  if (status) {
    conditions.push('gc.status = ?');
    params.push(status);
  }

  if (energyType) {
    conditions.push('gc.energy_type = ?');
    params.push(energyType);
  }

  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }

  sql += ' ORDER BY gc.created_at DESC LIMIT 500';

  return db.prepare(sql).all(...params);
}

module.exports = {
  issueGreenCertificatesForClearing,
  setAnnualQuota,
  getQuotaSetting,
  listQuotaSettings,
  getGeneratorGcAccount,
  getConsumerQuotaProgress,
  createTradingSession,
  getTradingSession,
  getTradingSessionByMonth,
  listTradingSessions,
  updateSessionStatus,
  submitSellOrder,
  submitBuyOrder,
  getSellOrder,
  getBuyOrder,
  listSessionOrders,
  performMatching,
  listSessionTrades,
  performAnnualAssessment,
  listAnnualAssessments,
  listTransferRecords,
  listCertificates
};
