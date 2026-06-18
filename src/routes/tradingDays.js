const express = require('express');
const router = express.Router();
const tradingDayService = require('../services/tradingDayService');
const clearingService = require('../services/clearingService');
const settlementService = require('../services/settlementService');

router.post('/', (req, res) => {
  try {
    const result = tradingDayService.createTradingDay(req.body);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/', (req, res) => {
  try {
    const result = tradingDayService.listTradingDays();
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/date/:date', (req, res) => {
  try {
    const result = tradingDayService.getTradingDayByDate(req.params.date);
    if (!result) {
      return res.status(404).json({ success: false, error: '交易日不存在' });
    }
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/:id', (req, res) => {
  try {
    const result = tradingDayService.getTradingDayById(req.params.id);
    if (!result) {
      return res.status(404).json({ success: false, error: '交易日不存在' });
    }
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/:id/prices', (req, res) => {
  try {
    const result = tradingDayService.getClearingPrices(req.params.id);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/:id/clear', (req, res) => {
  try {
    const result = clearingService.executeClearing(req.params.id);
    res.json({ success: true, message: '出清完成', data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/:id/clearing', (req, res) => {
  try {
    const result = clearingService.getClearingSummary(req.params.id);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/:id/clearing/participant/:participantId', (req, res) => {
  try {
    const result = clearingService.getParticipantClearing(req.params.id, req.params.participantId);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/:id/settle', (req, res) => {
  try {
    const result = settlementService.executeSettlement(req.params.id);
    res.json({ success: true, message: '结算完成', data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/:id/settlement', (req, res) => {
  try {
    const result = settlementService.getSettlementByTradingDay(req.params.id);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/:id/settlement/participant/:participantId', (req, res) => {
  try {
    const result = settlementService.getSettlementByParticipant(req.params.id, req.params.participantId);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/:id/report/participant/:participantId', (req, res) => {
  try {
    const result = settlementService.getFullParticipantReport(req.params.id, req.params.participantId);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

module.exports = router;
