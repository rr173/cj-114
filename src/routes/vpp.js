const express = require('express');
const router = express.Router();
const vppService = require('../services/vppService');

router.post('/aggregators', (req, res) => {
  try {
    const result = vppService.registerAggregator(req.body);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/aggregators', (req, res) => {
  try {
    const result = vppService.listAggregators();
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/aggregators/:id', (req, res) => {
  try {
    const result = vppService.getAggregatorById(req.params.id);
    if (!result) {
      return res.status(404).json({ success: false, error: '聚合商不存在' });
    }
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/aggregators/code/:code', (req, res) => {
  try {
    const result = vppService.getAggregatorByCode(req.params.code);
    if (!result) {
      return res.status(404).json({ success: false, error: '聚合商不存在' });
    }
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/resources', (req, res) => {
  try {
    const result = vppService.registerResource(req.body);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/resources/aggregator/:aggregatorId', (req, res) => {
  try {
    const result = vppService.listResourcesByAggregator(req.params.aggregatorId);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/resources/:id', (req, res) => {
  try {
    const result = vppService.getResourceById(req.params.id);
    if (!result) {
      return res.status(404).json({ success: false, error: '资源不存在' });
    }
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/resources/code/:code', (req, res) => {
  try {
    const result = vppService.getResourceByCode(req.params.code);
    if (!result) {
      return res.status(404).json({ success: false, error: '资源不存在' });
    }
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.put('/resources/:id/state', (req, res) => {
  try {
    const { trading_day_id, hour, availability_factor, soc, max_charge_power_kw, max_discharge_power_kw } = req.body;
    const result = vppService.updateResourceState(
      req.params.id, trading_day_id, hour,
      { availability_factor, soc, max_charge_power_kw, max_discharge_power_kw }
    );
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/resources/:id/state', (req, res) => {
  try {
    const { trading_day_id, hour } = req.query;
    const result = vppService.getResourceState(req.params.id, trading_day_id, hour != null ? parseInt(hour) : null);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/aggregators/:id/resource-states', (req, res) => {
  try {
    const { trading_day_id } = req.query;
    const result = vppService.listResourceStatesByAggregator(req.params.id, trading_day_id);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/aggregators/:id/adjustable-capacity', (req, res) => {
  try {
    const { trading_day_id, hour } = req.query;
    let result;
    if (hour != null) {
      result = vppService.calculateAggregatorAdjustableCapacity(req.params.id, trading_day_id, parseInt(hour));
    } else {
      result = vppService.calculateVppAdjustableCapacity(req.params.id, trading_day_id);
    }
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/aggregators/:id/bids', (req, res) => {
  try {
    const { trading_day_id, bids } = req.body;
    const result = vppService.submitVppBid(req.params.id, trading_day_id, bids);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/aggregators/:id/bids', (req, res) => {
  try {
    const { trading_day_id } = req.query;
    const result = vppService.getVppBids(req.params.id, trading_day_id);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/aggregators/:id/distribute-output', (req, res) => {
  try {
    const { trading_day_id, hour, total_output_kw } = req.body;
    const result = vppService.distributeOutput(req.params.id, trading_day_id, parseInt(hour), total_output_kw);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/aggregators/:id/output-distribution', (req, res) => {
  try {
    const { trading_day_id } = req.query;
    const result = vppService.getOutputDistribution(req.params.id, trading_day_id);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/resources/:id/output-distribution', (req, res) => {
  try {
    const { trading_day_id } = req.query;
    const result = vppService.getResourceOutputDistribution(req.params.id, trading_day_id);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/resources/:id/actual-output', (req, res) => {
  try {
    const { trading_day_id, hour, actual_output_kw } = req.body;
    const result = vppService.submitActualOutput(req.params.id, trading_day_id, parseInt(hour), actual_output_kw);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/actual-outputs/batch', (req, res) => {
  try {
    const { trading_day_id, outputs } = req.body;
    const result = vppService.submitActualOutputsBatch(trading_day_id, outputs);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/resources/:id/actual-outputs', (req, res) => {
  try {
    const { trading_day_id } = req.query;
    const result = vppService.getActualOutputsByResource(req.params.id, trading_day_id);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/aggregators/:id/actual-outputs', (req, res) => {
  try {
    const { trading_day_id } = req.query;
    const result = vppService.getActualOutputsByAggregator(req.params.id, trading_day_id);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/aggregators/:id/evaluate-performance', (req, res) => {
  try {
    const { trading_day_id } = req.body;
    const result = vppService.evaluatePerformanceAndRedistribute(req.params.id, trading_day_id);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/resources/:id/performance-records', (req, res) => {
  try {
    const { trading_day_id } = req.query;
    const result = vppService.getResourcePerformanceRecords(req.params.id, trading_day_id);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/aggregators/:id/performance-summary', (req, res) => {
  try {
    const { trading_day_id } = req.query;
    const result = vppService.getAggregatorPerformanceSummary(req.params.id, trading_day_id);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/resources/:id/performance-summary', (req, res) => {
  try {
    const { month } = req.query;
    const result = vppService.getResourcePerformanceSummary(req.params.id, month);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/aggregators/:id/settlement', (req, res) => {
  try {
    const { trading_day_id, market_data } = req.body;
    const result = vppService.executeVppSettlement(req.params.id, trading_day_id, market_data);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/aggregators/:id/settlement', (req, res) => {
  try {
    const { trading_day_id } = req.query;
    const result = vppService.getVppSettlement(req.params.id, trading_day_id);
    if (!result) {
      return res.status(404).json({ success: false, error: '结算记录不存在' });
    }
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/settlements/:settlementId/revenue-allocations', (req, res) => {
  try {
    const result = vppService.getVppRevenueAllocations(req.params.settlementId);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/resources/:id/revenue-allocations', (req, res) => {
  try {
    const { trading_day_id } = req.query;
    const result = vppService.getResourceRevenueAllocations(req.params.id, trading_day_id);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

module.exports = router;
