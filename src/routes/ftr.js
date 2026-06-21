const express = require('express');
const router = express.Router();
const ftrService = require('../services/ftrService');

router.post('/auctions', (req, res) => {
  try {
    const data = req.body;
    const result = ftrService.openAuction(data);
    res.json({ success: true, message: 'FTR拍卖已开启', data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/auctions', (req, res) => {
  try {
    const filters = {};
    if (req.query.month) filters.month = req.query.month;
    if (req.query.status) filters.status = req.query.status;
    if (req.query.tie_line_id) filters.tie_line_id = req.query.tie_line_id;
    const result = ftrService.listAuctions(filters);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/auctions/:auctionId', (req, res) => {
  try {
    const result = ftrService.getAuctionById(req.params.auctionId);
    if (!result) {
      return res.status(404).json({ success: false, error: '拍卖不存在' });
    }
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/auctions/no/:auctionNo', (req, res) => {
  try {
    const result = ftrService.getAuctionByNo(req.params.auctionNo);
    if (!result) {
      return res.status(404).json({ success: false, error: '拍卖不存在' });
    }
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/bids', (req, res) => {
  try {
    const { auction_id, participant_id, bid_capacity_mw, bid_price } = req.body;
    const result = ftrService.submitBid(
      auction_id,
      participant_id,
      bid_capacity_mw,
      bid_price
    );
    res.json({ success: true, message: 'FTR竞拍报价提交成功', data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.delete('/bids/:bidId', (req, res) => {
  try {
    const result = ftrService.cancelBid(req.params.bidId);
    res.json({ success: true, message: '报价已取消', data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/auctions/:auctionId/clearing', (req, res) => {
  try {
    const result = ftrService.executeAuctionClearing(req.params.auctionId);
    res.json({ success: true, message: 'FTR拍卖出清完成', data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/auctions/:auctionId/result', (req, res) => {
  try {
    const result = ftrService.getAuctionById(req.params.auctionId);
    if (!result) {
      return res.status(404).json({ success: false, error: '拍卖不存在' });
    }
    const summary = {
      auction_no: result.auction_no,
      month: result.month,
      status: result.status,
      clearing_price: result.clearing_price,
      total_capacity_mw: result.total_capacity_mw,
      total_cleared_capacity_mw: result.total_cleared_capacity_mw,
      bid_count: result.bid_count,
      direction: {
        from_zone: result.direction_from_zone,
        to_zone: result.direction_to_zone
      },
      winners: result.bids
        .filter(b => b.status === 'accepted' || b.status === 'partial')
        .map(b => ({
          participant_id: b.participant_id,
          participant_code: b.participant_code,
          participant_name: b.participant_name,
          bid_capacity_mw: b.bid_capacity_mw,
          bid_price: b.bid_price,
          cleared_capacity_mw: b.cleared_capacity_mw,
          clearing_price: b.clearing_price,
          payment_amount: b.payment_amount,
          status: b.status
        })),
      all_bids: result.bids.map(b => ({
        participant_id: b.participant_id,
        participant_code: b.participant_code,
        participant_name: b.participant_name,
        bid_capacity_mw: b.bid_capacity_mw,
        bid_price: b.bid_price,
        cleared_capacity_mw: b.cleared_capacity_mw || 0,
        status: b.status
      }))
    };
    res.json({ success: true, data: summary });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/participants/:participantId/holdings', (req, res) => {
  try {
    const filters = {};
    if (req.query.month) filters.month = req.query.month;
    if (req.query.status) filters.status = req.query.status;
    const result = ftrService.getParticipantHoldings(
      req.params.participantId,
      filters
    );
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/participants/:participantId/bids', (req, res) => {
  try {
    const filters = {};
    if (req.query.month) filters.month = req.query.month;
    if (req.query.status) filters.status = req.query.status;
    const result = ftrService.listParticipantBids(
      req.params.participantId,
      filters
    );
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/holdings/month/:month', (req, res) => {
  try {
    const result = ftrService.getActiveHoldingsForMonth(req.params.month);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/daily-settlement/:tradingDayId', (req, res) => {
  try {
    const result = ftrService.executeDailyFtrSettlement(req.params.tradingDayId);
    res.json({ success: true, message: 'FTR每日结算完成', data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/daily-settlement/:tradingDayId', (req, res) => {
  try {
    const result = ftrService.getDailySettlement(req.params.tradingDayId);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/daily-settlement/:tradingDayId/participant/:participantId', (req, res) => {
  try {
    const result = ftrService.getDailySettlementForParticipant(
      req.params.tradingDayId,
      req.params.participantId
    );
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/monthly-report/:month', (req, res) => {
  try {
    const result = ftrService.generateMonthlyReport(req.params.month);
    res.json({ success: true, message: 'FTR月度报告生成完成', data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/monthly-report/:month', (req, res) => {
  try {
    const result = ftrService.getMonthlyReport(req.params.month);
    if (!result) {
      return res.status(404).json({ success: false, error: '该月份月报尚未生成' });
    }
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/surplus-pool/:month', (req, res) => {
  try {
    const result = ftrService.getSurplusPool(req.params.month);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/price-trend', (req, res) => {
  try {
    const result = ftrService.getClearingPriceTrend();
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

module.exports = router;
