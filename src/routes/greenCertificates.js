const express = require('express');
const router = express.Router();
const gcService = require('../services/greenCertificateService');

router.post('/quota', (req, res) => {
  try {
    const { year, quota_ratio, penalty_price } = req.body;
    const result = gcService.setAnnualQuota(year, quota_ratio, penalty_price);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/quota', (req, res) => {
  try {
    const result = gcService.listQuotaSettings();
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/quota/:year', (req, res) => {
  try {
    const result = gcService.getQuotaSetting(parseInt(req.params.year));
    if (!result) {
      return res.status(404).json({ success: false, error: '该年度未设置配额' });
    }
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/issue/:tradingDayId', (req, res) => {
  try {
    const result = gcService.issueGreenCertificatesForClearing(req.params.tradingDayId);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/generator/:generatorId/account', (req, res) => {
  try {
    const { year } = req.query;
    const result = gcService.getGeneratorGcAccount(
      req.params.generatorId,
      year ? parseInt(year) : null
    );
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/consumer/:consumerId/progress', (req, res) => {
  try {
    const { year } = req.query;
    if (!year) {
      return res.status(400).json({ success: false, error: '年份必填' });
    }
    const result = gcService.getConsumerQuotaProgress(
      req.params.consumerId,
      parseInt(year)
    );
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/sessions', (req, res) => {
  try {
    const { year, month, bid_start_time, bid_end_time } = req.body;
    const result = gcService.createTradingSession(year, month, bid_start_time, bid_end_time);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/sessions', (req, res) => {
  try {
    const { status } = req.query;
    const result = gcService.listTradingSessions(status);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/sessions/:id', (req, res) => {
  try {
    const result = gcService.getTradingSession(req.params.id);
    if (!result) {
      return res.status(404).json({ success: false, error: '交易场次不存在' });
    }
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.put('/sessions/:id/status', (req, res) => {
  try {
    const { status } = req.body;
    const result = gcService.updateSessionStatus(req.params.id, status);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/sessions/:id/orders', (req, res) => {
  try {
    const result = gcService.listSessionOrders(req.params.id);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/sessions/:id/sell-orders', (req, res) => {
  try {
    const { seller_id, min_price, quantity } = req.body;
    const result = gcService.submitSellOrder(req.params.id, seller_id, min_price, quantity);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/sessions/:id/buy-orders', (req, res) => {
  try {
    const { buyer_id, max_price, quantity } = req.body;
    const result = gcService.submitBuyOrder(req.params.id, buyer_id, max_price, quantity);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/sessions/:id/matching', (req, res) => {
  try {
    const result = gcService.performMatching(req.params.id);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/sessions/:id/trades', (req, res) => {
  try {
    const result = gcService.listSessionTrades(req.params.id);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/assessment/:year', (req, res) => {
  try {
    const result = gcService.performAnnualAssessment(parseInt(req.params.year));
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/assessment/:year', (req, res) => {
  try {
    const result = gcService.listAnnualAssessments(parseInt(req.params.year));
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/transfers', (req, res) => {
  try {
    const { participant_id, type } = req.query;
    const result = gcService.listTransferRecords(participant_id, type);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/certificates', (req, res) => {
  try {
    const { owner_id, status, energy_type } = req.query;
    const result = gcService.listCertificates(owner_id, status, energy_type);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

module.exports = router;
