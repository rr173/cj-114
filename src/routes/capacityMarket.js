const express = require('express');
const router = express.Router();
const capacityMarketService = require('../services/capacityMarketService');

router.post('/demand/:month', (req, res) => {
  try {
    const { peak_load_forecast, reserve_margin } = req.body;
    const result = capacityMarketService.setMonthlyDemand(
      req.params.month,
      peak_load_forecast,
      reserve_margin
    );
    res.json({ success: true, message: '月度总容量需求设定成功', data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/demand/:month', (req, res) => {
  try {
    const result = capacityMarketService.getMonthlyDemand(req.params.month);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/obligations/:month', (req, res) => {
  try {
    const result = capacityMarketService.allocateCapacityObligations(req.params.month);
    res.json({ success: true, message: '容量义务分配完成', data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/obligations/:month', (req, res) => {
  try {
    const result = capacityMarketService.getCapacityObligations(req.params.month);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/obligations/:month/participant/:participantId', (req, res) => {
  try {
    const result = capacityMarketService.getCapacityObligations(
      req.params.month,
      req.params.participantId
    );
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/bidding/:month/open', (req, res) => {
  try {
    const { bid_start_time, bid_end_time } = req.body;
    const result = capacityMarketService.openBiddingSession(
      req.params.month,
      bid_start_time,
      bid_end_time
    );
    res.json({ success: true, message: '容量竞标窗口已开放', data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/bidding/:month/close', (req, res) => {
  try {
    const result = capacityMarketService.closeBiddingSession(req.params.month);
    res.json({ success: true, message: '容量竞标窗口已关闭', data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/bidding/:month', (req, res) => {
  try {
    const result = capacityMarketService.getBiddingSession(req.params.month);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/bid/:month/:participantId', (req, res) => {
  try {
    const { offered_capacity_mw, price_yuan_per_mw_month } = req.body;
    const result = capacityMarketService.submitCapacityBid(
      req.params.month,
      req.params.participantId,
      offered_capacity_mw,
      price_yuan_per_mw_month
    );
    res.json({ success: true, message: '容量竞标提交成功', data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/bid/:month/:participantId', (req, res) => {
  try {
    const result = capacityMarketService.getParticipantBid(
      req.params.month,
      req.params.participantId
    );
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/clearing/:month', (req, res) => {
  try {
    const result = capacityMarketService.executeCapacityClearing(req.params.month);
    res.json({ success: true, message: '容量出清完成', data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/clearing/:month', (req, res) => {
  try {
    const result = capacityMarketService.getClearingResult(req.params.month);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/clearing/:month/participant/:participantId', (req, res) => {
  try {
    const result = capacityMarketService.getClearingResultByParticipant(
      req.params.month,
      req.params.participantId
    );
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/availability-check/:tradingDayId', (req, res) => {
  try {
    const result = capacityMarketService.checkCapacityAvailability(req.params.tradingDayId);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/shortage-events/:month', (req, res) => {
  try {
    const result = capacityMarketService.getShortageEvents(req.params.month);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/shortage-events/:month/participant/:participantId', (req, res) => {
  try {
    const result = capacityMarketService.getShortageEvents(
      req.params.month,
      req.params.participantId
    );
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/assessment/:month', (req, res) => {
  try {
    const result = capacityMarketService.calculateAvailabilityAssessment(req.params.month);
    res.json({ success: true, message: '可用性考核完成', data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/assessment/:month', (req, res) => {
  try {
    const result = capacityMarketService.getAvailabilityAssessments(req.params.month);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/assessment/:month/participant/:participantId', (req, res) => {
  try {
    const result = capacityMarketService.getAvailabilityAssessments(
      req.params.month,
      req.params.participantId
    );
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/settlement/:month', (req, res) => {
  try {
    const result = capacityMarketService.generateMonthlySettlement(req.params.month);
    res.json({ success: true, message: '月度容量结算单生成完成', data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/settlement/:month', (req, res) => {
  try {
    const result = capacityMarketService.getSettlement(req.params.month);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/price-history', (req, res) => {
  try {
    const result = capacityMarketService.getClearingPriceHistory();
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

module.exports = router;
