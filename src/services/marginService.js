const { v4: uuidv4 } = require('uuid');
const db = require('../utils/db');
const { getParticipantById } = require('./participantService');
const { getMarginRatio, getCurrentCreditScore } = require('./creditService');

const DEVIATION_PENALTY_THRESHOLD = 0.5;
const DEVIATION_PENALTY_MULTIPLIER = 0.1;

function getOrCreateAccount(participantId) {
  let account = db.prepare(`
    SELECT * FROM credit_margin_accounts WHERE participant_id = ?
  `).get(participantId);

  if (!account) {
    const id = uuidv4();
    db.prepare(`
      INSERT INTO credit_margin_accounts (id, participant_id, balance, frozen_amount)
      VALUES (?, ?, 0, 0)
    `).run(id, participantId);
    account = db.prepare(`
      SELECT * FROM credit_margin_accounts WHERE participant_id = ?
    `).get(participantId);
  }

  return account;
}

function getAccount(participantId) {
  const account = getOrCreateAccount(participantId);
  const participant = getParticipantById(participantId);
  return {
    ...account,
    participant_code: participant?.code,
    participant_name: participant?.name,
    available_balance: account.balance - account.frozen_amount
  };
}

function _recordTransaction(accountId, participantId, type, amount, balanceAfter, frozenAfter, referenceType, referenceId, description) {
  db.prepare(`
    INSERT INTO credit_margin_transactions
    (id, account_id, participant_id, transaction_type, amount, balance_after, frozen_after,
     reference_type, reference_id, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    uuidv4(), accountId, participantId, type, amount, balanceAfter, frozenAfter,
    referenceType, referenceId, description
  );
}

function depositMargin(participantId, amount, description = '保证金充值') {
  if (amount <= 0) {
    throw new Error('充值金额必须大于0');
  }

  const participant = getParticipantById(participantId);
  if (!participant) {
    throw new Error('市场主体不存在');
  }

  const tx = db.transaction(() => {
    const account = getOrCreateAccount(participantId);
    const newBalance = account.balance + amount;
    
    db.prepare(`
      UPDATE credit_margin_accounts 
      SET balance = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(newBalance, account.id);

    _recordTransaction(
      account.id, participantId, 'deposit', amount,
      newBalance, account.frozen_amount,
      null, null, description
    );

    return {
      account_id: account.id,
      participant_id: participantId,
      deposit_amount: amount,
      balance_before: account.balance,
      balance_after: newBalance,
      frozen_amount: account.frozen_amount,
      available_balance: newBalance - account.frozen_amount
    };
  });

  return tx();
}

function calculateRequiredMargin(participantId, tradingDayId) {
  const credit = getCurrentCreditScore(participantId);
  const marginRatio = getMarginRatio(credit.level);
  
  const totalBidAmount = db.prepare(`
    SELECT SUM(price * capacity) as total_amount
    FROM generator_bids
    WHERE trading_day_id = ? AND participant_id = ?
  `).get(tradingDayId, participantId)?.total_amount || 0;

  const totalConsumerAmount = db.prepare(`
    SELECT SUM(max_price * demand) as total_amount
    FROM consumer_bids
    WHERE trading_day_id = ? AND participant_id = ?
  `).get(tradingDayId, participantId)?.total_amount || 0;

  const totalAmount = totalBidAmount + totalConsumerAmount;
  const requiredMargin = Math.round(totalAmount * marginRatio * 100) / 100;

  return {
    participant_id: participantId,
    credit_level: credit.level,
    margin_ratio: marginRatio,
    total_bid_amount: Math.round(totalAmount * 100) / 100,
    required_margin: requiredMargin
  };
}

function freezeMargin(participantId, tradingDayId, bids) {
  const participant = getParticipantById(participantId);
  if (!participant) {
    throw new Error('市场主体不存在');
  }

  const credit = getCurrentCreditScore(participantId);
  if (credit.balance < 0) {
    throw new Error('保证金账户余额为负，请先补缴保证金后再报价');
  }

  let totalBidAmount = 0;
  if (participant.type === 'generator') {
    for (const bid of bids) {
      if (bid.segments) {
        for (const seg of bid.segments) {
          totalBidAmount += (seg.price || 0) * (seg.capacity || 0);
        }
      }
    }
  } else {
    for (const bid of bids) {
      totalBidAmount += (bid.max_price || 0) * (bid.demand || 0);
    }
  }

  const marginRatio = getMarginRatio(credit.level);
  const requiredMargin = Math.round(totalBidAmount * marginRatio * 100) / 100;

  if (requiredMargin <= 0) {
    return null;
  }

  const tx = db.transaction(() => {
    const account = getOrCreateAccount(participantId);
    const available = account.balance - account.frozen_amount;

    if (available < requiredMargin) {
      throw new Error(`保证金不足，需要 ${requiredMargin} 元，当前可用 ${Math.round(available * 100) / 100} 元`);
    }

    const existingFreeze = db.prepare(`
      SELECT * FROM credit_margin_freezes 
      WHERE participant_id = ? AND trading_day_id = ?
    `).get(participantId, tradingDayId);

    if (existingFreeze) {
      const newFrozenAmount = account.frozen_amount - existingFreeze.amount + requiredMargin;
      
      db.prepare(`
        UPDATE credit_margin_freezes
        SET amount = ?, status = 'frozen', created_at = datetime('now'), unfrozen_at = NULL
        WHERE id = ?
      `).run(requiredMargin, existingFreeze.id);

      db.prepare(`
        UPDATE credit_margin_accounts
        SET frozen_amount = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(newFrozenAmount, account.id);

      _recordTransaction(
        account.id, participantId, 'freeze', requiredMargin - existingFreeze.amount,
        account.balance, newFrozenAmount,
        'trading_day', tradingDayId,
        `调整交易日保证金冻结，原${existingFreeze.amount}元，现${requiredMargin}元`
      );
    } else {
      const newFrozenAmount = account.frozen_amount + requiredMargin;
      
      db.prepare(`
        INSERT INTO credit_margin_freezes
        (id, account_id, participant_id, trading_day_id, amount, status)
        VALUES (?, ?, ?, ?, ?, 'frozen')
      `).run(uuidv4(), account.id, participantId, tradingDayId, requiredMargin);

      db.prepare(`
        UPDATE credit_margin_accounts
        SET frozen_amount = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(newFrozenAmount, account.id);

      _recordTransaction(
        account.id, participantId, 'freeze', requiredMargin,
        account.balance, newFrozenAmount,
        'trading_day', tradingDayId,
        `交易日保证金冻结 ${requiredMargin} 元`
      );
    }

    return {
      participant_id: participantId,
      trading_day_id: tradingDayId,
      credit_level: credit.level,
      margin_ratio: marginRatio,
      total_bid_amount: Math.round(totalBidAmount * 100) / 100,
      frozen_amount: requiredMargin,
      balance: account.balance,
      frozen_after: account.frozen_amount + (existingFreeze ? (requiredMargin - existingFreeze.amount) : requiredMargin),
      available_after: account.balance - (account.frozen_amount + (existingFreeze ? (requiredMargin - existingFreeze.amount) : requiredMargin))
    };
  });

  return tx();
}

function unfreezeMargin(participantId, tradingDayId) {
  const tx = db.transaction(() => {
    const freeze = db.prepare(`
      SELECT * FROM credit_margin_freezes 
      WHERE participant_id = ? AND trading_day_id = ? AND status = 'frozen'
    `).get(participantId, tradingDayId);

    if (!freeze) {
      return null;
    }

    const account = db.prepare(`
      SELECT * FROM credit_margin_accounts WHERE id = ?
    `).get(freeze.account_id);

    const newFrozenAmount = Math.max(0, account.frozen_amount - freeze.amount);

    db.prepare(`
      UPDATE credit_margin_freezes
      SET status = 'unfrozen', unfrozen_at = datetime('now')
      WHERE id = ?
    `).run(freeze.id);

    db.prepare(`
      UPDATE credit_margin_accounts
      SET frozen_amount = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(newFrozenAmount, account.id);

    _recordTransaction(
      account.id, participantId, 'unfreeze', -freeze.amount,
      account.balance, newFrozenAmount,
      'trading_day', tradingDayId,
      `交易日保证金解冻 ${freeze.amount} 元`
    );

    return {
      participant_id: participantId,
      trading_day_id: tradingDayId,
      unfrozen_amount: freeze.amount,
      balance: account.balance,
      frozen_after: newFrozenAmount,
      available_after: account.balance - newFrozenAmount
    };
  });

  return tx();
}

function penalizeDeviation(participantId, tradingDayId) {
  const tx = db.transaction(() => {
    const tradingDay = db.prepare(`
      SELECT trade_date FROM trading_days WHERE id = ?
    `).get(tradingDayId);

    if (!tradingDay) {
      throw new Error('交易日不存在');
    }

    const allocations = db.prepare(`
      SELECT cr.hour, cr.clearing_price, ca.final_dispatch
      FROM clearing_results cr
      JOIN clearing_allocations ca ON cr.id = ca.clearing_result_id
      WHERE cr.trading_day_id = ? AND ca.participant_id = ?
    `).all(tradingDayId, participantId);

    const actualVolumes = db.prepare(`
      SELECT hour, actual_volume FROM actual_volumes
      WHERE trading_day_id = ? AND participant_id = ?
    `).all(tradingDayId, participantId);

    const actualMap = {};
    for (const av of actualVolumes) {
      actualMap[av.hour] = av.actual_volume;
    }

    const participant = getParticipantById(participantId);
    const capacity = participant?.type === 'generator' 
      ? participant.installed_capacity 
      : participant?.contracted_capacity || 0;

    if (capacity === 0) {
      return null;
    }

    let totalPenalty = 0;
    const penaltyDetails = [];

    for (const alloc of allocations) {
      const expected = alloc.final_dispatch || 0;
      const actual = actualMap[alloc.hour] || 0;
      const deviation = expected > 0 ? Math.abs(actual - expected) / expected : 0;

      if (deviation > DEVIATION_PENALTY_THRESHOLD) {
        const deviationEnergy = Math.abs(actual - expected);
        const penalty = deviationEnergy * alloc.clearing_price * DEVIATION_PENALTY_MULTIPLIER;
        totalPenalty += penalty;
        penaltyDetails.push({
          hour: alloc.hour,
          expected,
          actual,
          deviation_ratio: Math.round(deviation * 10000) / 10000,
          deviation_energy: deviationEnergy,
          clearing_price: alloc.clearing_price,
          penalty_amount: Math.round(penalty * 100) / 100
        });
      }
    }

    if (totalPenalty <= 0) {
      return null;
    }

    const freeze = db.prepare(`
      SELECT * FROM credit_margin_freezes 
      WHERE participant_id = ? AND trading_day_id = ?
    `).get(participantId, tradingDayId);

    const account = getOrCreateAccount(participantId);
    const penaltyAmount = Math.round(totalPenalty * 100) / 100;
    const newBalance = Math.round((account.balance - penaltyAmount) * 100) / 100;
    let newFrozenAmount = account.frozen_amount;

    if (freeze && freeze.status === 'frozen') {
      newFrozenAmount = Math.max(0, account.frozen_amount - freeze.amount);
      
      db.prepare(`
        UPDATE credit_margin_freezes
        SET status = 'penalized', penalty_amount = ?, unfrozen_at = datetime('now')
        WHERE id = ?
      `).run(penaltyAmount, freeze.id);
    }

    db.prepare(`
      UPDATE credit_margin_accounts
      SET balance = ?, frozen_amount = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(newBalance, newFrozenAmount, account.id);

    _recordTransaction(
      account.id, participantId, 'penalty', -penaltyAmount,
      newBalance, newFrozenAmount,
      'trading_day', tradingDayId,
      `偏差违约扣罚 ${penaltyAmount} 元，涉及 ${penaltyDetails.length} 个时段`
    );

    return {
      participant_id: participantId,
      trading_day_id: tradingDayId,
      total_penalty: penaltyAmount,
      balance_before: account.balance,
      balance_after: newBalance,
      penalty_details: penaltyDetails,
      warning: newBalance < 0 ? '保证金账户余额为负，下次报价前需补缴' : null
    };
  });

  return tx();
}

function getFreezeDetails(participantId, tradingDayId = null) {
  let sql = `
    SELECT f.*, td.trade_date, td.status as trading_day_status
    FROM credit_margin_freezes f
    JOIN trading_days td ON f.trading_day_id = td.id
    WHERE f.participant_id = ?
  `;
  const params = [participantId];

  if (tradingDayId) {
    sql += ' AND f.trading_day_id = ?';
    params.push(tradingDayId);
  }

  sql += ' ORDER BY f.created_at DESC';

  return db.prepare(sql).all(...params);
}

function getTransactionHistory(participantId, limit = 50) {
  return db.prepare(`
    SELECT t.*, td.trade_date
    FROM credit_margin_transactions t
    LEFT JOIN trading_days td ON t.reference_id = td.id AND t.reference_type = 'trading_day'
    WHERE t.participant_id = ?
    ORDER BY t.created_at DESC
    LIMIT ?
  `).all(participantId, limit);
}

function adjustBalance(participantId, amount, reason, operator) {
  if (!reason || !reason.trim()) {
    throw new Error('调整原因不能为空');
  }
  if (!operator || !operator.trim()) {
    throw new Error('操作人不能为空');
  }

  const tx = db.transaction(() => {
    const account = getOrCreateAccount(participantId);
    const newBalance = Math.round((account.balance + amount) * 100) / 100;

    db.prepare(`
      UPDATE credit_margin_accounts
      SET balance = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(newBalance, account.id);

    _recordTransaction(
      account.id, participantId, 'adjustment', amount,
      newBalance, account.frozen_amount,
      'manual', null,
      `${reason}（操作人：${operator}）`
    );

    return {
      participant_id: participantId,
      adjustment_amount: amount,
      balance_before: account.balance,
      balance_after: newBalance,
      reason,
      operator
    };
  });

  return tx();
}

module.exports = {
  getAccount,
  getOrCreateAccount,
  depositMargin,
  calculateRequiredMargin,
  freezeMargin,
  unfreezeMargin,
  penalizeDeviation,
  getFreezeDetails,
  getTransactionHistory,
  adjustBalance,
  DEVIATION_PENALTY_THRESHOLD,
  DEVIATION_PENALTY_MULTIPLIER
};
