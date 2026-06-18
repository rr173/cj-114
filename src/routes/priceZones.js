const express = require('express');
const router = express.Router();
const priceZoneService = require('../services/priceZoneService');

router.post('/', (req, res) => {
  try {
    const result = priceZoneService.createPriceZone(req.body);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/', (req, res) => {
  try {
    const result = priceZoneService.listPriceZones();
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/:id', (req, res) => {
  try {
    const result = priceZoneService.getPriceZoneById(req.params.id);
    if (!result) {
      return res.status(404).json({ success: false, error: '电价区不存在' });
    }
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/code/:code', (req, res) => {
  try {
    const result = priceZoneService.getPriceZoneByCode(req.params.code);
    if (!result) {
      return res.status(404).json({ success: false, error: '电价区不存在' });
    }
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/:zoneId/participants/:participantId', (req, res) => {
  try {
    const result = priceZoneService.assignParticipantToZone(
      req.params.zoneId,
      req.params.participantId
    );
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.delete('/:zoneId/participants/:participantId', (req, res) => {
  try {
    const result = priceZoneService.removeParticipantFromZone(
      req.params.zoneId,
      req.params.participantId
    );
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    priceZoneService.deletePriceZone(req.params.id);
    res.json({ success: true, message: '电价区已删除' });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

module.exports = router;
