const express = require('express');
const router = express.Router();
const participantService = require('../services/participantService');

router.post('/', (req, res) => {
  try {
    const result = participantService.registerParticipant(req.body);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/', (req, res) => {
  try {
    const { type } = req.query;
    const result = participantService.listParticipants(type);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/:id', (req, res) => {
  try {
    const result = participantService.getParticipantById(req.params.id);
    if (!result) {
      return res.status(404).json({ success: false, error: '主体不存在' });
    }
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/code/:code', (req, res) => {
  try {
    const result = participantService.getParticipantByCode(req.params.code);
    if (!result) {
      return res.status(404).json({ success: false, error: '主体不存在' });
    }
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

module.exports = router;
