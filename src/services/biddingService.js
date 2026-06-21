const { v4: uuidv4 } = require('uuid');
const db = require('../utils/db');
const { getTradingDayById, isBiddingOpen } = require('./tradingDayService');
const { getParticipantById } = require('./participantService');
const { isTradingRestricted, getTradingLimitRatio } = require('./creditService');
const { freezeMargin } = require('./marginService');

function submitGeneratorBid(tradingDayId, participantId, bids) {
  const td = getTradingDayById(tradingDayId);
  if (!td) {
    throw new Error('交易日不存在');
  }
  if (!isBiddingOpen(tradingDayId)) {
    throw new Error('报价窗口已关闭');
  }

  const participant = getParticipantById(participantId);
  if (!participant) {
    throw new Error('市场主体不存在');
  }
  if (participant.type !== 'generator') {
    throw new Error('该主体不是发电侧，不能提交发电报价');
  }

  if (isTradingRestricted(participantId)) {
    throw new Error('信用不足，交易已被限制，请联系管理员');
  }

  if (!Array.isArray(bids) || bids.length === 0) {
    throw new Error('报价数据不能为空');
  }

  const limitRatio = getTradingLimitRatio(participantId);
  const maxCapacity = participant.installed_capacity * limitRatio;

  const grouped = {};
  for (const bid of bids) {
    const { hour, segments } = bid;
    if (hour == null || hour < 0 || hour > 23) {
      throw new Error('时段必须在 0-23 之间');
    }
    if (!Array.isArray(segments) || segments.length === 0 || segments.length > 5) {
      throw new Error(`时段 ${hour} 的价量段数量必须在 1-5 之间`);
    }
    let totalCapacity = 0;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (seg.price == null || seg.price < 0) {
        throw new Error(`时段 ${hour} 第 ${i + 1} 段价格无效`);
      }
      if (seg.capacity == null || seg.capacity <= 0) {
        throw new Error(`时段 ${hour} 第 ${i + 1} 段容量无效`);
      }
      totalCapacity += seg.capacity;
    }
    if (totalCapacity > maxCapacity) {
      if (limitRatio < 1) {
        throw new Error(`时段 ${hour} 报价总容量超过信用限额 ${maxCapacity} MW（当前信用等级B，限额为装机容量的80%）`);
      } else {
        throw new Error(`时段 ${hour} 报价总容量超过装机容量`);
      }
    }
    grouped[hour] = segments;
  }

  const marginResult = freezeMargin(participantId, tradingDayId, bids);

  const tx = db.transaction(() => {
    const deleteStmt = db.prepare(`
      DELETE FROM generator_bids 
      WHERE trading_day_id = ? AND participant_id = ? AND hour = ?
    `);
    const insertStmt = db.prepare(`
      INSERT INTO generator_bids (id, trading_day_id, participant_id, hour, segment_index, price, capacity)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const hour of Object.keys(grouped)) {
      deleteStmt.run(tradingDayId, participantId, parseInt(hour));
      const segments = grouped[hour];
      for (let i = 0; i < segments.length; i++) {
        insertStmt.run(
          uuidv4(),
          tradingDayId,
          participantId,
          parseInt(hour),
          i,
          segments[i].price,
          segments[i].capacity
        );
      }
    }
  });

  tx();

  const result = getGeneratorBids(tradingDayId, participantId);
  return {
    bids: result,
    margin_info: marginResult
  };
}

function submitConsumerBid(tradingDayId, participantId, bids) {
  const td = getTradingDayById(tradingDayId);
  if (!td) {
    throw new Error('交易日不存在');
  }
  if (!isBiddingOpen(tradingDayId)) {
    throw new Error('报价窗口已关闭');
  }

  const participant = getParticipantById(participantId);
  if (!participant) {
    throw new Error('市场主体不存在');
  }
  if (participant.type !== 'consumer') {
    throw new Error('该主体不是用电侧，不能提交用电报价');
  }

  if (isTradingRestricted(participantId)) {
    throw new Error('信用不足，交易已被限制，请联系管理员');
  }

  if (!Array.isArray(bids) || bids.length === 0) {
    throw new Error('报价数据不能为空');
  }

  const limitRatio = getTradingLimitRatio(participantId);
  const maxCapacity = participant.contracted_capacity * limitRatio;

  for (const bid of bids) {
    const { hour, demand, max_price } = bid;
    if (hour == null || hour < 0 || hour > 23) {
      throw new Error('时段必须在 0-23 之间');
    }
    if (demand == null || demand <= 0) {
      throw new Error(`时段 ${hour} 需求量无效`);
    }
    if (max_price == null || max_price < 0) {
      throw new Error(`时段 ${hour} 最高可接受电价无效`);
    }
    if (demand > maxCapacity) {
      if (limitRatio < 1) {
        throw new Error(`时段 ${hour} 需求量超过信用限额 ${maxCapacity} MW（当前信用等级B，限额为签约容量的80%）`);
      } else {
        throw new Error(`时段 ${hour} 需求量超过签约容量`);
      }
    }
  }

  const marginResult = freezeMargin(participantId, tradingDayId, bids);

  const tx = db.transaction(() => {
    const deleteStmt = db.prepare(`
      DELETE FROM consumer_bids 
      WHERE trading_day_id = ? AND participant_id = ? AND hour = ?
    `);
    const upsertStmt = db.prepare(`
      INSERT INTO consumer_bids (id, trading_day_id, participant_id, hour, demand, max_price)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const bid of bids) {
      deleteStmt.run(tradingDayId, participantId, bid.hour);
      upsertStmt.run(
        uuidv4(),
        tradingDayId,
        participantId,
        bid.hour,
        bid.demand,
        bid.max_price
      );
    }
  });

  tx();

  const result = getConsumerBids(tradingDayId, participantId);
  return {
    bids: result,
    margin_info: marginResult
  };
}

function getGeneratorBids(tradingDayId, participantId) {
  const rows = db.prepare(`
    SELECT hour, segment_index, price, capacity 
    FROM generator_bids 
    WHERE trading_day_id = ? AND participant_id = ?
    ORDER BY hour, segment_index
  `).all(tradingDayId, participantId);

  const result = [];
  const hourMap = {};
  for (const row of rows) {
    if (!hourMap[row.hour]) {
      hourMap[row.hour] = { hour: row.hour, segments: [] };
      result.push(hourMap[row.hour]);
    }
    hourMap[row.hour].segments.push({
      segment_index: row.segment_index,
      price: row.price,
      capacity: row.capacity
    });
  }
  return result;
}

function getConsumerBids(tradingDayId, participantId) {
  return db.prepare(`
    SELECT hour, demand, max_price 
    FROM consumer_bids 
    WHERE trading_day_id = ? AND participant_id = ?
    ORDER BY hour
  `).all(tradingDayId, participantId);
}

function getAllGeneratorBidsByHour(tradingDayId, hour) {
  return db.prepare(`
    SELECT g.participant_id, g.price, g.capacity, p.installed_capacity
    FROM generator_bids g
    JOIN market_participants p ON g.participant_id = p.id
    WHERE g.trading_day_id = ? AND g.hour = ?
    ORDER BY g.price ASC
  `).all(tradingDayId, hour);
}

function getAllConsumerBidsByHour(tradingDayId, hour) {
  return db.prepare(`
    SELECT participant_id, demand, max_price
    FROM consumer_bids
    WHERE trading_day_id = ? AND hour = ?
    ORDER BY max_price DESC
  `).all(tradingDayId, hour);
}

module.exports = {
  submitGeneratorBid,
  submitConsumerBid,
  getGeneratorBids,
  getConsumerBids,
  getAllGeneratorBidsByHour,
  getAllConsumerBidsByHour
};
