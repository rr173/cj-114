const express = require('express');
const router = express.Router();
const intradayService = require('../services/intradayService');

router.post('/orders/:tradingDayId/:participantId', (req, res) => {
  try {
    const options = {};
    if (req.query.skip_window_check === 'true') options.skipWindowCheck = true;
    if (req.query.current_time) options.currentTime = req.query.current_time;

    const result = intradayService.submitOrder(
      req.params.tradingDayId,
      req.params.participantId,
      req.body,
      options
    );
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.delete('/orders/:orderId', (req, res) => {
  try {
    const result = intradayService.cancelOrder(req.params.orderId);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/order-book/:tradingDayId/:hour', (req, res) => {
  try {
    const result = intradayService.getOrderBook(
      req.params.tradingDayId,
      parseInt(req.params.hour)
    );
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/match/:tradingDayId/:hour', (req, res) => {
  try {
    const options = {};
    if (req.query.skip_window_check === 'true') options.skipWindowCheck = true;
    if (req.query.current_time) options.currentTime = req.query.current_time;

    const result = intradayService.executeMatching(
      req.params.tradingDayId,
      parseInt(req.params.hour),
      options
    );
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/trades/:tradingDayId', (req, res) => {
  try {
    const hour = req.query.hour != null ? parseInt(req.query.hour) : null;
    const result = intradayService.getTradeRecords(req.params.tradingDayId, hour);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/summary/:tradingDayId/:participantId', (req, res) => {
  try {
    const result = intradayService.getParticipantDailySummary(
      req.params.tradingDayId,
      req.params.participantId
    );
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/window/:tradingDayId/:hour', (req, res) => {
  try {
    const currentTime = req.query.current_time || null;
    const info = intradayService.getTradingWindowInfo(
      req.params.tradingDayId,
      parseInt(req.params.hour),
      currentTime
    );
    res.json({ success: true, data: { hour: parseInt(req.params.hour), ...info } });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

module.exports = router;
