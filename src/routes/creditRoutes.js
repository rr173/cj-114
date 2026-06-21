const express = require('express');
const router = express.Router();
const creditService = require('../services/creditService');
const marginService = require('../services/marginService');
const { getParticipantById } = require('../services/participantService');

router.get('/score/:participantId', (req, res) => {
  try {
    const { participantId } = req.params;
    const participant = getParticipantById(participantId);
    if (!participant) {
      return res.status(404).json({ success: false, error: '市场主体不存在' });
    }
    const result = creditService.getCurrentCreditScore(participantId);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/ranking', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const result = creditService.getCreditRanking(limit);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/adjust', (req, res) => {
  try {
    const { participant_id, month, new_score, reason, operator } = req.body;
    
    if (!participant_id) {
      return res.status(400).json({ success: false, error: '市场主体ID为必填项' });
    }
    if (new_score == null) {
      return res.status(400).json({ success: false, error: '新信用分为必填项' });
    }
    if (!reason) {
      return res.status(400).json({ success: false, error: '调整原因为必填项' });
    }
    if (!operator) {
      return res.status(400).json({ success: false, error: '操作人为必填项' });
    }

    const result = creditService.adjustCreditScore(
      participant_id,
      month,
      parseFloat(new_score),
      reason,
      operator
    );
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/history/:participantId', (req, res) => {
  try {
    const { participantId } = req.params;
    const limit = parseInt(req.query.limit) || 12;
    const participant = getParticipantById(participantId);
    if (!participant) {
      return res.status(404).json({ success: false, error: '市场主体不存在' });
    }
    const result = creditService.getCreditHistory(participantId, limit);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/recalculate', (req, res) => {
  try {
    const { month } = req.body;
    const result = creditService.recalculateAllCreditScores(month);
    res.json({ 
      success: true, 
      data: { 
        month: month || new Date().toISOString().slice(0, 7),
        updated_count: result.length,
        results: result 
      } 
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/margin/account/:participantId', (req, res) => {
  try {
    const { participantId } = req.params;
    const participant = getParticipantById(participantId);
    if (!participant) {
      return res.status(404).json({ success: false, error: '市场主体不存在' });
    }
    const result = marginService.getAccount(participantId);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/margin/freeze/:participantId', (req, res) => {
  try {
    const { participantId } = req.params;
    const { trading_day_id } = req.query;
    const participant = getParticipantById(participantId);
    if (!participant) {
      return res.status(404).json({ success: false, error: '市场主体不存在' });
    }
    const result = marginService.getFreezeDetails(participantId, trading_day_id);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/margin/deposit', (req, res) => {
  try {
    const { participant_id, amount, description } = req.body;
    
    if (!participant_id) {
      return res.status(400).json({ success: false, error: '市场主体ID为必填项' });
    }
    if (amount == null || parseFloat(amount) <= 0) {
      return res.status(400).json({ success: false, error: '充值金额必须大于0' });
    }

    const result = marginService.depositMargin(
      participant_id,
      parseFloat(amount),
      description
    );
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/margin/transactions/:participantId', (req, res) => {
  try {
    const { participantId } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    const participant = getParticipantById(participantId);
    if (!participant) {
      return res.status(404).json({ success: false, error: '市场主体不存在' });
    }
    const result = marginService.getTransactionHistory(participantId, limit);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/margin/calculate', (req, res) => {
  try {
    const { participant_id, trading_day_id } = req.body;
    
    if (!participant_id) {
      return res.status(400).json({ success: false, error: '市场主体ID为必填项' });
    }
    if (!trading_day_id) {
      return res.status(400).json({ success: false, error: '交易日ID为必填项' });
    }

    const result = marginService.calculateRequiredMargin(participant_id, trading_day_id);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/margin/penalize', (req, res) => {
  try {
    const { participant_id, trading_day_id } = req.body;
    
    if (!participant_id) {
      return res.status(400).json({ success: false, error: '市场主体ID为必填项' });
    }
    if (!trading_day_id) {
      return res.status(400).json({ success: false, error: '交易日ID为必填项' });
    }

    const result = marginService.penalizeDeviation(participant_id, trading_day_id);
    if (!result) {
      return res.json({ 
        success: true, 
        data: { 
          message: '该交易日无偏差超过50%的违约时段，无需扣罚',
          total_penalty: 0 
        } 
      });
    }
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

module.exports = router;
