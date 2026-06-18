const express = require('express');
const router = express.Router();
const biddingService = require('../services/biddingService');

router.post('/generator/:tradingDayId/:participantId', (req, res) => {
  try {
    const result = biddingService.submitGeneratorBid(
      req.params.tradingDayId,
      req.params.participantId,
      req.body
    );
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/consumer/:tradingDayId/:participantId', (req, res) => {
  try {
    const result = biddingService.submitConsumerBid(
      req.params.tradingDayId,
      req.params.participantId,
      req.body
    );
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/generator/:tradingDayId/:participantId', (req, res) => {
  try {
    const result = biddingService.getGeneratorBids(
      req.params.tradingDayId,
      req.params.participantId
    );
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/consumer/:tradingDayId/:participantId', (req, res) => {
  try {
    const result = biddingService.getConsumerBids(
      req.params.tradingDayId,
      req.params.participantId
    );
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

module.exports = router;
