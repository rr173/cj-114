const express = require('express');
const router = express.Router();
const tieLineService = require('../services/tieLineService');

router.post('/', (req, res) => {
  try {
    const result = tieLineService.createTieLine(req.body);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/', (req, res) => {
  try {
    const result = tieLineService.listTieLines();
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/:id', (req, res) => {
  try {
    const result = tieLineService.getTieLineById(req.params.id);
    if (!result) {
      return res.status(404).json({ success: false, error: '联络线不存在' });
    }
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/code/:code', (req, res) => {
  try {
    const result = tieLineService.getTieLineByCode(req.params.code);
    if (!result) {
      return res.status(404).json({ success: false, error: '联络线不存在' });
    }
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.put('/:id/max-capacity', (req, res) => {
  try {
    const { max_transfer_capacity } = req.body;
    const result = tieLineService.updateMaxTransferCapacity(
      req.params.id,
      max_transfer_capacity
    );
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    tieLineService.deleteTieLine(req.params.id);
    res.json({ success: true, message: '联络线已删除' });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

module.exports = router;
