const express = require('express');
const router = express.Router();
const disputeService = require('../services/settlementDisputeService');

router.post('/create', (req, res) => {
  try {
    const { trading_day_id, participant_id, dispute_type, description } = req.body;
    const result = disputeService.createDispute(
      trading_day_id,
      participant_id,
      dispute_type,
      description
    );
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/withdraw/:disputeId', (req, res) => {
  try {
    const result = disputeService.withdrawDispute(req.params.disputeId);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/accept/:disputeId', (req, res) => {
  try {
    const result = disputeService.acceptDispute(req.params.disputeId);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/participant/:participantId', (req, res) => {
  try {
    const { status } = req.query;
    const result = disputeService.listDisputesByParticipant(
      req.params.participantId,
      status
    );
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/trading-day/:tradingDayId', (req, res) => {
  try {
    const result = disputeService.listDisputesByTradingDay(req.params.tradingDayId);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/:disputeId', (req, res) => {
  try {
    const result = disputeService.getDisputeById(req.params.disputeId);
    if (!result) {
      return res.status(404).json({ success: false, error: '争议不存在' });
    }
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/recalculate/:disputeId', (req, res) => {
  try {
    const result = disputeService.triggerRecalculation(req.params.disputeId);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/difference/:disputeId', (req, res) => {
  try {
    const result = disputeService.getDifferenceReport(req.params.disputeId);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/approve/:disputeId', (req, res) => {
  try {
    const result = disputeService.approveDispute(req.params.disputeId);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/reject/:disputeId', (req, res) => {
  try {
    const { reason } = req.body;
    const result = disputeService.rejectDispute(req.params.disputeId, reason);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/refunds', (req, res) => {
  try {
    const { dispute_id, participant_id } = req.query;
    const result = disputeService.getRefundDetails(dispute_id, participant_id);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

module.exports = router;
