const express = require('express');
const router = express.Router();
const settlementService = require('../services/settlementService');

router.post('/actual/:tradingDayId/:participantId', (req, res) => {
  try {
    const result = settlementService.submitActualVolumes(
      req.params.tradingDayId,
      req.params.participantId,
      req.body
    );
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/actual/:tradingDayId/:participantId', (req, res) => {
  try {
    const result = settlementService.getActualVolumes(
      req.params.tradingDayId,
      req.params.participantId
    );
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/execute/:tradingDayId', (req, res) => {
  try {
    const result = settlementService.executeSettlement(req.params.tradingDayId);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/trading-day/:tradingDayId', (req, res) => {
  try {
    const result = settlementService.getSettlementByTradingDay(req.params.tradingDayId);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/participant/:tradingDayId/:participantId', (req, res) => {
  try {
    const result = settlementService.getSettlementByParticipant(
      req.params.tradingDayId,
      req.params.participantId
    );
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/report/:tradingDayId/:participantId', (req, res) => {
  try {
    const result = settlementService.getFullParticipantReport(
      req.params.tradingDayId,
      req.params.participantId
    );
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

module.exports = router;
