const express = require('express');
const router = express.Router();
const contractService = require('../services/contractService');

router.post('/', (req, res) => {
  try {
    const result = contractService.createContract(req.body);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/', (req, res) => {
  try {
    const { participant_id, status, buyer_id, seller_id } = req.query;
    const result = contractService.listContracts({ participant_id, status, buyer_id, seller_id });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/:id', (req, res) => {
  try {
    const result = contractService.getContractById(req.params.id);
    if (!result) {
      return res.status(404).json({ success: false, error: '合约不存在' });
    }
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/no/:contractNo', (req, res) => {
  try {
    const result = contractService.getContractByNo(req.params.contractNo);
    if (!result) {
      return res.status(404).json({ success: false, error: '合约不存在' });
    }
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/terminate/:id', (req, res) => {
  try {
    const { termination_date } = req.body;
    const result = contractService.terminateContract(req.params.id, termination_date);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/decompose', (req, res) => {
  try {
    const { trade_date } = req.body;
    const result = contractService.decomposeContractsForDate(trade_date);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/decomposition/date/:tradeDate', (req, res) => {
  try {
    const { dimension } = req.query;
    if (dimension) {
      const result = contractService.getDecompositionAggregated(req.params.tradeDate, dimension);
      res.json({ success: true, data: result });
    } else {
      const result = contractService.getDecompositionByDate(req.params.tradeDate);
      res.json({ success: true, data: result });
    }
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/decomposition/trading-day/:tradingDayId', (req, res) => {
  try {
    const result = contractService.getDecompositionByTradingDay(req.params.tradingDayId);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/performance/:contractId', (req, res) => {
  try {
    const result = contractService.getContractPerformance(req.params.contractId);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/performance/participant/:participantId', (req, res) => {
  try {
    const result = contractService.getParticipantContractsPerformance(req.params.participantId);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

module.exports = router;
