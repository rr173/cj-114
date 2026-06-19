const { v4: uuidv4 } = require('uuid');
const db = require('../utils/db');
const { getTradingDayById } = require('./tradingDayService');
const { getParticipantById } = require('./participantService');
const { getDecompositionByDate } = require('./contractService');

function getTradingWindowInfo(tradingDayId, hour, currentTime) {
  const td = getTradingDayById(tradingDayId);
  if (!td) throw new Error('交易日不存在');

  if (td.status === 'bidding') {
    return {
      is_open: false,
      reason: 'trading_day_not_cleared',
      message: `该交易日当前状态为"bidding"，尚未执行日前出清，日内交易窗口未开启`,
      open_time: null,
      close_time: null,
      current_time: (currentTime ? new Date(currentTime) : new Date()).toISOString()
    };
  }
  if (td.status === 'settled') {
    return {
      is_open: false,
      reason: 'trading_day_settled',
      message: `该交易日当前状态为"settled"，已完成结算，日内交易窗口已关闭`,
      open_time: null,
      close_time: null,
      current_time: (currentTime ? new Date(currentTime) : new Date()).toISOString()
    };
  }

  const now = currentTime ? new Date(currentTime) : new Date();
  const tradeDate = td.trade_date;
  const [year, month, day] = tradeDate.split('-').map(Number);

  let openHour = hour - 2;
  const openDate = new Date(year, month - 1, day);
  if (openHour < 0) {
    openHour += 24;
    openDate.setDate(openDate.getDate() - 1);
  }

  let closeHour = hour - 1;
  let closeMinute = 30;
  const closeDate = new Date(year, month - 1, day);
  if (closeHour < 0) {
    closeHour += 24;
    closeDate.setDate(closeDate.getDate() - 1);
  }

  const openTime = new Date(
    openDate.getFullYear(), openDate.getMonth(), openDate.getDate(),
    openHour, 0, 0
  );
  const closeTime = new Date(
    closeDate.getFullYear(), closeDate.getMonth(), closeDate.getDate(),
    closeHour, closeMinute, 0
  );

  const isOpen = now >= openTime && now < closeTime;
  let reason = 'in_window';
  let message = `时段${hour}的日内交易窗口已开放`;
  if (!isOpen) {
    if (now < openTime) {
      reason = 'before_window';
      message = `时段${hour}的日内交易窗口尚未开放，开放时间为${openTime.toLocaleString('zh-CN')}（该时段前2小时），当前时间${now.toLocaleString('zh-CN')}`;
    } else {
      reason = 'after_window';
      message = `时段${hour}的日内交易窗口已关闭，关闭时间为${closeTime.toLocaleString('zh-CN')}（该时段前30分钟），当前时间${now.toLocaleString('zh-CN')}`;
    }
  }

  return {
    is_open: isOpen,
    reason,
    message,
    open_time: openTime.toISOString(),
    close_time: closeTime.toISOString(),
    current_time: now.toISOString()
  };
}

function isTradingWindowOpen(tradingDayId, hour, currentTime) {
  const info = getTradingWindowInfo(tradingDayId, hour, currentTime);
  return info.is_open;
}

function getDayAheadClearedVolume(tradingDayId, participantId, hour) {
  const row = db.prepare(`
    SELECT ca.final_dispatch
    FROM clearing_allocations ca
    JOIN clearing_results cr ON ca.clearing_result_id = cr.id
    WHERE cr.trading_day_id = ? AND ca.participant_id = ? AND cr.hour = ?
  `).get(tradingDayId, participantId, hour);
  return row ? row.final_dispatch : 0;
}

function getContractVolumeForHour(tradingDayId, participantId, hour) {
  const td = getTradingDayById(tradingDayId);
  if (!td) return 0;
  const decomposition = getDecompositionByDate(td.trade_date);
  let total = 0;
  for (const d of decomposition) {
    if (d.hour === hour && (d.buyer_id === participantId || d.seller_id === participantId)) {
      total += d.decomposed_energy;
    }
  }
  return total;
}

function getExistingExposure(tradingDayId, participantId, hour, orderType) {
  const rows = db.prepare(`
    SELECT quantity FROM intraday_orders
    WHERE trading_day_id = ? AND participant_id = ? AND hour = ?
    AND order_type = ? AND status != 'cancelled'
  `).all(tradingDayId, participantId, hour, orderType);
  return rows.reduce((sum, r) => sum + r.quantity, 0);
}

function validateOrder(tradingDayId, participantId, hour, orderType, quantity) {
  const p = getParticipantById(participantId);
  if (!p) throw new Error('市场主体不存在');

  const dayAheadVolume = getDayAheadClearedVolume(tradingDayId, participantId, hour);
  const contractVolume = getContractVolumeForHour(tradingDayId, participantId, hour);

  if (orderType === 'increase_gen') {
    if (p.type !== 'generator') throw new Error('只有电厂可以提交增发意愿');
    const existing = getExistingExposure(tradingDayId, participantId, hour, 'increase_gen');
    const maxQty = p.installed_capacity - dayAheadVolume - existing;
    if (maxQty <= 0) throw new Error('没有增发空间(装机容量已全部分配)');
    if (quantity > maxQty) {
      throw new Error(
        `增发量 ${quantity} 超过剩余空间 ${maxQty.toFixed(2)} MW (装机容量${p.installed_capacity} - 日前中标${dayAheadVolume.toFixed(2)} - 已挂增发${existing.toFixed(2)})`
      );
    }
  } else if (orderType === 'decrease_gen') {
    if (p.type !== 'generator') throw new Error('只有电厂可以提交减发意愿');
    const existing = getExistingExposure(tradingDayId, participantId, hour, 'decrease_gen');
    const maxQty = dayAheadVolume - p.min_output - existing;
    if (maxQty <= 0) throw new Error('没有减发空间(日前中标量已接近最小出力)');
    if (quantity > maxQty) {
      throw new Error(
        `减发量 ${quantity} 超过可调空间 ${maxQty.toFixed(2)} MW (日前中标${dayAheadVolume.toFixed(2)} - 最小出力${p.min_output} - 已挂减发${existing.toFixed(2)})`
      );
    }
  } else if (orderType === 'increase_con') {
    if (p.type !== 'consumer') throw new Error('只有售电公司可以提交增购意愿');
    const existing = getExistingExposure(tradingDayId, participantId, hour, 'increase_con');
    const currentObligation = dayAheadVolume + contractVolume;
    const maxQty = p.contracted_capacity - currentObligation - existing;
    if (maxQty <= 0) throw new Error('没有增购空间(签约容量已全部分配)');
    if (quantity > maxQty) {
      throw new Error(
        `增购量 ${quantity} 超过剩余空间 ${maxQty.toFixed(2)} MW (签约容量${p.contracted_capacity} - 当前应交${currentObligation.toFixed(2)} - 已挂增购${existing.toFixed(2)})`
      );
    }
  } else if (orderType === 'decrease_con') {
    if (p.type !== 'consumer') throw new Error('只有售电公司可以提交减购意愿');
    const existing = getExistingExposure(tradingDayId, participantId, hour, 'decrease_con');
    const currentObligation = dayAheadVolume + contractVolume;
    const maxQty = currentObligation - existing;
    if (maxQty <= 0) throw new Error('没有减购空间(当前应交量已为零)');
    if (quantity > maxQty) {
      throw new Error(
        `减购量 ${quantity} 超过当前应交量 ${maxQty.toFixed(2)} MW (当前应交${currentObligation.toFixed(2)} - 已挂减购${existing.toFixed(2)})`
      );
    }
  }
}

function submitOrder(tradingDayId, participantId, data, options = {}) {
  const { hour, order_type, quantity, price } = data;

  const td = getTradingDayById(tradingDayId);
  if (!td) throw new Error('交易日不存在');
  if (td.status === 'bidding') throw new Error('该交易日尚未出清，无法进行日内交易');
  if (td.status === 'settled') throw new Error('该交易日已完成结算，无法进行日内交易');

  if (hour == null || hour < 0 || hour > 23) throw new Error('时段必须在0-23之间');
  if (!quantity || quantity <= 0) throw new Error('挂单量必须大于0');
  if (!price || price <= 0) throw new Error('报价必须大于0');

  const validOrderTypes = ['increase_gen', 'decrease_gen', 'increase_con', 'decrease_con'];
  if (!validOrderTypes.includes(order_type)) throw new Error('挂单类型无效，必须是 increase_gen/decrease_gen/increase_con/decrease_con');

  if (!options.skipWindowCheck) {
    const winInfo = getTradingWindowInfo(tradingDayId, hour, options.currentTime);
    if (!winInfo.is_open) {
      throw new Error(`时段 ${hour} 的日内交易窗口未开放：${winInfo.message}`);
    }
  }

  validateOrder(tradingDayId, participantId, hour, order_type, quantity);

  const side = (order_type === 'increase_gen' || order_type === 'decrease_con') ? 'sell' : 'buy';

  const id = uuidv4();
  db.prepare(`
    INSERT INTO intraday_orders (id, trading_day_id, participant_id, hour, order_type, side, quantity, price, remaining_quantity, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
  `).run(id, tradingDayId, participantId, hour, order_type, side, quantity, price, quantity);

  return getOrderById(id);
}

function getOrderById(id) {
  return db.prepare(`
    SELECT o.*, p.code, p.name, p.type as participant_type
    FROM intraday_orders o
    JOIN market_participants p ON o.participant_id = p.id
    WHERE o.id = ?
  `).get(id);
}

function cancelOrder(orderId) {
  const order = db.prepare('SELECT * FROM intraday_orders WHERE id = ?').get(orderId);
  if (!order) throw new Error('挂单不存在');
  if (order.status === 'filled') throw new Error('已完全成交的挂单无法撤销');
  if (order.status === 'cancelled') throw new Error('挂单已撤销');

  db.prepare("UPDATE intraday_orders SET status = 'cancelled', remaining_quantity = 0 WHERE id = ?").run(orderId);
  return getOrderById(orderId);
}

function executeMatching(tradingDayId, hour, options = {}) {
  const td = getTradingDayById(tradingDayId);
  if (!td) throw new Error('交易日不存在');
  if (td.status === 'bidding') throw new Error('该交易日尚未出清');
  if (td.status === 'settled') throw new Error('该交易日已完成结算');

  if (!options.skipWindowCheck) {
    const winInfo = getTradingWindowInfo(tradingDayId, hour, options.currentTime);
    if (!winInfo.is_open) {
      throw new Error(`时段 ${hour} 的日内交易窗口未开放，无法执行撮合：${winInfo.message}`);
    }
  }

  const buyOrders = db.prepare(`
    SELECT * FROM intraday_orders
    WHERE trading_day_id = ? AND hour = ? AND side = 'buy' AND status IN ('pending', 'partial')
    ORDER BY price DESC, created_at ASC
  `).all(tradingDayId, hour);

  const sellOrders = db.prepare(`
    SELECT * FROM intraday_orders
    WHERE trading_day_id = ? AND hour = ? AND side = 'sell' AND status IN ('pending', 'partial')
    ORDER BY price ASC, created_at ASC
  `).all(tradingDayId, hour);

  const trades = [];

  const tx = db.transaction(() => {
    let bi = 0;
    let si = 0;
    while (bi < buyOrders.length && si < sellOrders.length) {
      const buy = buyOrders[bi];
      const sell = sellOrders[si];

      if (buy.price < sell.price) break;

      const tradeQty = Math.min(buy.remaining_quantity, sell.remaining_quantity);
      const tradePrice = Math.round((buy.price + sell.price) / 2 * 100) / 100;

      const tradeId = uuidv4();
      db.prepare(`
        INSERT INTO intraday_trades (id, trading_day_id, hour, buy_order_id, sell_order_id, buy_participant_id, sell_participant_id, trade_quantity, trade_price)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(tradeId, tradingDayId, hour, buy.id, sell.id, buy.participant_id, sell.participant_id, tradeQty, tradePrice);

      const newBuyRemaining = buy.remaining_quantity - tradeQty;
      const newSellRemaining = sell.remaining_quantity - tradeQty;

      db.prepare('UPDATE intraday_orders SET remaining_quantity = ?, status = ? WHERE id = ?')
        .run(newBuyRemaining, newBuyRemaining === 0 ? 'filled' : 'partial', buy.id);
      db.prepare('UPDATE intraday_orders SET remaining_quantity = ?, status = ? WHERE id = ?')
        .run(newSellRemaining, newSellRemaining === 0 ? 'filled' : 'partial', sell.id);

      buy.remaining_quantity = newBuyRemaining;
      sell.remaining_quantity = newSellRemaining;

      trades.push({
        id: tradeId,
        trading_day_id: tradingDayId,
        hour,
        buy_order_id: buy.id,
        sell_order_id: sell.id,
        buy_participant_id: buy.participant_id,
        sell_participant_id: sell.participant_id,
        trade_quantity: tradeQty,
        trade_price: tradePrice
      });

      if (newBuyRemaining === 0) bi++;
      if (newSellRemaining === 0) si++;
    }
  });

  tx();

  return {
    trading_day_id: tradingDayId,
    hour,
    matched_count: trades.length,
    trades
  };
}

function getOrderBook(tradingDayId, hour) {
  const td = getTradingDayById(tradingDayId);
  if (!td) throw new Error('交易日不存在');

  const buyOrders = db.prepare(`
    SELECT o.id, o.participant_id, o.order_type, o.quantity, o.price, o.remaining_quantity, o.status, o.created_at,
           p.code, p.name, p.type as participant_type
    FROM intraday_orders o
    JOIN market_participants p ON o.participant_id = p.id
    WHERE o.trading_day_id = ? AND o.hour = ? AND o.side = 'buy' AND o.status IN ('pending', 'partial')
    ORDER BY o.price DESC, o.created_at ASC
  `).all(tradingDayId, hour);

  const sellOrders = db.prepare(`
    SELECT o.id, o.participant_id, o.order_type, o.quantity, o.price, o.remaining_quantity, o.status, o.created_at,
           p.code, p.name, p.type as participant_type
    FROM intraday_orders o
    JOIN market_participants p ON o.participant_id = p.id
    WHERE o.trading_day_id = ? AND o.hour = ? AND o.side = 'sell' AND o.status IN ('pending', 'partial')
    ORDER BY o.price ASC, o.created_at ASC
  `).all(tradingDayId, hour);

  return {
    trading_day_id: tradingDayId,
    hour,
    buy_orders: buyOrders,
    sell_orders: sellOrders
  };
}

function getTradeRecords(tradingDayId, hour) {
  const td = getTradingDayById(tradingDayId);
  if (!td) throw new Error('交易日不存在');

  let sql = `
    SELECT t.*,
           bp.code AS buy_code, bp.name AS buy_name, bp.type AS buy_type,
           sp.code AS sell_code, sp.name AS sell_name, sp.type AS sell_type
    FROM intraday_trades t
    JOIN market_participants bp ON t.buy_participant_id = bp.id
    JOIN market_participants sp ON t.sell_participant_id = sp.id
    WHERE t.trading_day_id = ?
  `;
  const params = [tradingDayId];

  if (hour != null) {
    sql += ' AND t.hour = ?';
    params.push(hour);
  }

  sql += ' ORDER BY t.hour, t.created_at ASC';

  return db.prepare(sql).all(...params);
}

function getParticipantDailySummary(tradingDayId, participantId) {
  const td = getTradingDayById(tradingDayId);
  if (!td) throw new Error('交易日不存在');
  const p = getParticipantById(participantId);
  if (!p) throw new Error('市场主体不存在');

  const trades = db.prepare(`
    SELECT t.trade_quantity, t.trade_price, t.hour,
           CASE WHEN t.buy_participant_id = ? THEN 'buy' ELSE 'sell' END AS role
    FROM intraday_trades t
    WHERE t.trading_day_id = ? AND (t.buy_participant_id = ? OR t.sell_participant_id = ?)
    ORDER BY t.hour, t.created_at
  `).all(participantId, tradingDayId, participantId, participantId);

  let totalBuyQty = 0;
  let totalSellQty = 0;
  let totalBuyAmount = 0;
  let totalSellAmount = 0;

  const hourlyDetail = {};

  for (const t of trades) {
    if (!hourlyDetail[t.hour]) {
      hourlyDetail[t.hour] = { hour: t.hour, buy_qty: 0, sell_qty: 0, buy_amount: 0, sell_amount: 0 };
    }
    if (t.role === 'buy') {
      totalBuyQty += t.trade_quantity;
      totalBuyAmount += t.trade_quantity * t.trade_price;
      hourlyDetail[t.hour].buy_qty += t.trade_quantity;
      hourlyDetail[t.hour].buy_amount += t.trade_quantity * t.trade_price;
    } else {
      totalSellQty += t.trade_quantity;
      totalSellAmount += t.trade_quantity * t.trade_price;
      hourlyDetail[t.hour].sell_qty += t.trade_quantity;
      hourlyDetail[t.hour].sell_amount += t.trade_quantity * t.trade_price;
    }
  }

  const netPosition = totalBuyQty - totalSellQty;
  const buyWeightedAvg = totalBuyQty > 0 ? totalBuyAmount / totalBuyQty : 0;
  const sellWeightedAvg = totalSellQty > 0 ? totalSellAmount / totalSellQty : 0;

  const hourly = [];
  for (let h = 0; h < 24; h++) {
    const d = hourlyDetail[h];
    if (d) {
      hourly.push({
        hour: h,
        buy_qty: d.buy_qty,
        sell_qty: d.sell_qty,
        net_position: d.buy_qty - d.sell_qty,
        buy_amount: d.buy_amount,
        sell_amount: d.sell_amount
      });
    }
  }

  return {
    trading_day_id: tradingDayId,
    trade_date: td.trade_date,
    participant: { id: p.id, code: p.code, name: p.name, type: p.type },
    total_buy_quantity: totalBuyQty,
    total_sell_quantity: totalSellQty,
    net_position: netPosition,
    buy_weighted_avg_price: buyWeightedAvg,
    sell_weighted_avg_price: sellWeightedAvg,
    total_buy_amount: totalBuyAmount,
    total_sell_amount: totalSellAmount,
    hourly
  };
}

function getIntradayNetVolumes(tradingDayId) {
  const trades = db.prepare(`
    SELECT buy_participant_id, sell_participant_id, hour, trade_quantity, trade_price
    FROM intraday_trades
    WHERE trading_day_id = ?
  `).all(tradingDayId);

  const netVolumes = {};
  for (const t of trades) {
    if (!netVolumes[t.buy_participant_id]) netVolumes[t.buy_participant_id] = {};
    if (!netVolumes[t.sell_participant_id]) netVolumes[t.sell_participant_id] = {};
    if (!netVolumes[t.buy_participant_id][t.hour]) {
      netVolumes[t.buy_participant_id][t.hour] = { buy_qty: 0, sell_qty: 0, buy_amount: 0, sell_amount: 0 };
    }
    if (!netVolumes[t.sell_participant_id][t.hour]) {
      netVolumes[t.sell_participant_id][t.hour] = { buy_qty: 0, sell_qty: 0, buy_amount: 0, sell_amount: 0 };
    }
    netVolumes[t.buy_participant_id][t.hour].buy_qty += t.trade_quantity;
    netVolumes[t.buy_participant_id][t.hour].buy_amount += t.trade_quantity * t.trade_price;
    netVolumes[t.sell_participant_id][t.hour].sell_qty += t.trade_quantity;
    netVolumes[t.sell_participant_id][t.hour].sell_amount += t.trade_quantity * t.trade_price;
  }

  return netVolumes;
}

module.exports = {
  getTradingWindowInfo,
  isTradingWindowOpen,
  submitOrder,
  getOrderById,
  cancelOrder,
  executeMatching,
  getOrderBook,
  getTradeRecords,
  getParticipantDailySummary,
  getIntradayNetVolumes,
  getDayAheadClearedVolume,
  getContractVolumeForHour
};
