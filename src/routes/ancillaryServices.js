const express = require('express');
const router = express.Router();
const ancillaryService = require('../services/ancillaryService');

router.post('/registration/:participantId', (req, res) => {
  try {
    const result = ancillaryService.registerAncillaryService(
      req.params.participantId,
      req.body
    );
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/registration/:participantId', (req, res) => {
  try {
    const result = ancillaryService.getAncillaryRegistrations(
      req.params.participantId
    );
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/registration', (req, res) => {
  try {
    const result = ancillaryService.listAllRegistrations();
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/bid/:tradingDayId/:participantId', (req, res) => {
  try {
    const result = ancillaryService.submitAncillaryBid(
      req.params.tradingDayId,
      req.params.participantId,
      req.body
    );
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/bid/:tradingDayId/:participantId', (req, res) => {
  try {
    const result = ancillaryService.getAncillaryBids(
      req.params.tradingDayId,
      req.params.participantId
    );
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/bid/:tradingDayId', (req, res) => {
  try {
    const result = ancillaryService.getAncillaryBidsByTradingDay(
      req.params.tradingDayId
    );
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/clearing/:tradingDayId', (req, res) => {
  try {
    const result = ancillaryService.executeAncillaryClearing(
      req.params.tradingDayId
    );
    res.json({ success: true, message: '辅助服务出清完成', data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/clearing/:tradingDayId', (req, res) => {
  try {
    const result = ancillaryService.getAncillaryClearingResults(
      req.params.tradingDayId
    );
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/clearing/:tradingDayId/participant/:participantId', (req, res) => {
  try {
    const result = ancillaryService.getAncillaryClearingByParticipant(
      req.params.tradingDayId,
      req.params.participantId
    );
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/mileage/:participantId/:month', (req, res) => {
  try {
    const { actual_mileage } = req.body;
    const result = ancillaryService.submitActualMileage(
      req.params.participantId,
      req.params.month,
      actual_mileage
    );
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/settlement/:month', (req, res) => {
  try {
    const result = ancillaryService.executeAncillarySettlement(
      req.params.month
    );
    res.json({ success: true, message: '辅助服务月度结算完成', data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/settlement/:month/participant/:participantId', (req, res) => {
  try {
    const result = ancillaryService.getAncillarySettlement(
      req.params.participantId,
      req.params.month
    );
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/settlement/:month/summary', (req, res) => {
  try {
    const result = ancillaryService.getAncillarySettlementSummary(
      req.params.month
    );
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/comprehensive/:tradingDayId/:participantId', (req, res) => {
  try {
    const result = ancillaryService.getComprehensiveSettlementView(
      req.params.tradingDayId,
      req.params.participantId
    );
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

module.exports = router;
