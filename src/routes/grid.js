const express = require('express');
const router = express.Router();
const gridService = require('../services/gridService');

router.post('/buses', (req, res) => {
  try {
    const result = gridService.createBus(req.body);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/buses', (req, res) => {
  try {
    const result = gridService.listBuses();
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/buses/:id', (req, res) => {
  try {
    const result = gridService.getBusById(req.params.id);
    if (!result) {
      return res.status(404).json({ success: false, error: '电网节点不存在' });
    }
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/buses/code/:code', (req, res) => {
  try {
    const result = gridService.getBusByCode(req.params.code);
    if (!result) {
      return res.status(404).json({ success: false, error: '电网节点不存在' });
    }
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/lines', (req, res) => {
  try {
    const result = gridService.createLine(req.body);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/lines', (req, res) => {
  try {
    const result = gridService.listLines();
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/lines/:id', (req, res) => {
  try {
    const result = gridService.getLineById(req.params.id);
    if (!result) {
      return res.status(404).json({ success: false, error: '输电线路不存在' });
    }
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/buses/:busId/participants/:participantId', (req, res) => {
  try {
    const result = gridService.attachParticipantToBus(
      req.params.busId,
      req.params.participantId
    );
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.delete('/buses/:busId/participants/:participantId', (req, res) => {
  try {
    const result = gridService.detachParticipantFromBus(
      req.params.busId,
      req.params.participantId
    );
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/buses/:busId/participants', (req, res) => {
  try {
    const result = gridService.getBusParticipants(req.params.busId);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/participants/:participantId/buses', (req, res) => {
  try {
    const result = gridService.getParticipantBuses(req.params.participantId);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/topology/validate', (req, res) => {
  try {
    const result = gridService.checkTopologyConnectivity();
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/power-flow', (req, res) => {
  try {
    const { injections } = req.body;
    if (!injections || typeof injections !== 'object') {
      return res.status(400).json({ 
        success: false, 
        error: '请提供 injections 参数，格式为 { participantId: injection_mw }' 
      });
    }
    const result = gridService.calculatePowerFlow(injections);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/security-check/:tradingDayId/:hour', (req, res) => {
  try {
    const hour = parseInt(req.params.hour);
    if (isNaN(hour) || hour < 0 || hour > 23) {
      return res.status(400).json({ success: false, error: '时段必须是0-23之间的整数' });
    }
    const result = gridService.performSecurityCheck(req.params.tradingDayId, hour);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/security-check/full/:tradingDayId', (req, res) => {
  try {
    const result = gridService.performFullDaySecurityCheck(req.params.tradingDayId);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/security-alerts', (req, res) => {
  try {
    const tradingDayId = req.query.trading_day_id || null;
    const result = gridService.listSecurityAlerts(tradingDayId);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/security-alerts/:id', (req, res) => {
  try {
    const result = gridService.getAlertDetails(req.params.id);
    if (!result) {
      return res.status(404).json({ success: false, error: '安全校核告警不存在' });
    }
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/redispatch/:alertId', (req, res) => {
  try {
    const result = gridService.generateRedispatchSuggestion(req.params.alertId);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/nminus1/:tradingDayId/:hour', (req, res) => {
  try {
    const hour = parseInt(req.params.hour);
    if (isNaN(hour) || hour < 0 || hour > 23) {
      return res.status(400).json({ success: false, error: '时段必须是0-23之间的整数' });
    }
    const result = gridService.performNMinus1Check(req.params.tradingDayId, hour);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/nminus1-results', (req, res) => {
  try {
    const tradingDayId = req.query.trading_day_id || null;
    const result = gridService.listNMinus1Results(tradingDayId);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

module.exports = router;
