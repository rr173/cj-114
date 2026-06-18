const express = require('express');
const router = express.Router();
const supervisionService = require('../services/supervisionService');

router.post('/analyze/:tradingDayId', (req, res) => {
  try {
    const result = supervisionService.runFullAnalysis(req.params.tradingDayId);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/analyze/bidding/:tradingDayId', (req, res) => {
  try {
    const result = supervisionService.analyzeBiddingBehavior(req.params.tradingDayId);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/analyze/hhi/:tradingDayId', (req, res) => {
  try {
    const result = supervisionService.calculateHHI(req.params.tradingDayId);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/analyze/dominance/:tradingDayId', (req, res) => {
  try {
    const result = supervisionService.checkMarketDominance(req.params.tradingDayId);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/analyze/price/:tradingDayId', (req, res) => {
  try {
    const result = supervisionService.checkPriceFluctuation(req.params.tradingDayId);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/hhi/:tradeDate', (req, res) => {
  try {
    const result = supervisionService.getHHIByTradingDay(req.params.tradeDate);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/anomalies', (req, res) => {
  try {
    const filters = {};
    if (req.query.trade_date) filters.trade_date = req.query.trade_date;
    if (req.query.start_date) filters.start_date = req.query.start_date;
    if (req.query.end_date) filters.end_date = req.query.end_date;
    if (req.query.hour != null) filters.hour = parseInt(req.query.hour);
    if (req.query.participant_id) filters.participant_id = req.query.participant_id;
    if (req.query.anomaly_type) filters.anomaly_type = req.query.anomaly_type;
    const result = supervisionService.getAnomalies(filters);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/alerts', (req, res) => {
  try {
    const filters = {};
    if (req.query.trade_date) filters.trade_date = req.query.trade_date;
    if (req.query.start_date) filters.start_date = req.query.start_date;
    if (req.query.end_date) filters.end_date = req.query.end_date;
    if (req.query.alert_type) filters.alert_type = req.query.alert_type;
    if (req.query.participant_id) filters.participant_id = req.query.participant_id;
    const result = supervisionService.getAlerts(filters);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/report', (req, res) => {
  try {
    const { start_date, end_date, participant_id } = req.query;
    if (!start_date || !end_date) {
      return res.status(400).json({ success: false, error: '起止日期为必填项' });
    }
    const result = supervisionService.generateRegulatoryReport(start_date, end_date, participant_id);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/participant/:participantId', (req, res) => {
  try {
    const result = supervisionService.getParticipantAnomalyHistory(req.params.participantId);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

module.exports = router;
