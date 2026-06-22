const express = require('express');
const router = express.Router();
const monthlyReportService = require('../services/monthlyReportService');

const MONTH_PATTERN = /^\d{4}-\d{2}$/;

router.post('/generate', (req, res, next) => {
  try {
    const { month } = req.body;
    if (!month || !MONTH_PATTERN.test(month)) {
      return res.status(400).json({
        success: false,
        error: '请提供有效的月份参数，格式为 YYYY-MM'
      });
    }

    const report = monthlyReportService.generateMonthlyReport(month);
    res.json({
      success: true,
      message: `月度报告生成成功: ${month}`,
      data: report
    });
  } catch (e) {
    next(e);
  }
});

router.get('/:month', (req, res, next) => {
  try {
    const { month } = req.params;
    if (!MONTH_PATTERN.test(month)) {
      return res.status(400).json({
        success: false,
        error: '月份格式应为 YYYY-MM'
      });
    }

    const report = monthlyReportService.getReportByMonth(month);
    if (!report) {
      return res.status(404).json({
        success: false,
        error: `${month} 的月度报告不存在`
      });
    }

    res.json({
      success: true,
      data: report
    });
  } catch (e) {
    next(e);
  }
});

router.get('/', (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;

    if (limit < 1 || limit > 200) {
      return res.status(400).json({
        success: false,
        error: 'limit 参数应在 1-200 之间'
      });
    }
    if (offset < 0) {
      return res.status(400).json({
        success: false,
        error: 'offset 参数不能小于 0'
      });
    }

    const reports = monthlyReportService.listReports(limit, offset);
    res.json({
      success: true,
      data: reports,
      pagination: {
        limit,
        offset,
        count: reports.length
      }
    });
  } catch (e) {
    next(e);
  }
});

router.get('/compare/:month1/:month2', (req, res, next) => {
  try {
    const { month1, month2 } = req.params;

    if (!MONTH_PATTERN.test(month1) || !MONTH_PATTERN.test(month2)) {
      return res.status(400).json({
        success: false,
        error: '月份格式应为 YYYY-MM'
      });
    }

    const comparison = monthlyReportService.compareReports(month1, month2);
    res.json({
      success: true,
      data: comparison
    });
  } catch (e) {
    if (e.message.includes('不存在')) {
      return res.status(404).json({
        success: false,
        error: e.message
      });
    }
    next(e);
  }
});

router.delete('/:month', (req, res, next) => {
  try {
    const { month } = req.params;
    if (!MONTH_PATTERN.test(month)) {
      return res.status(400).json({
        success: false,
        error: '月份格式应为 YYYY-MM'
      });
    }

    const deleted = monthlyReportService.deleteReport(month);
    if (!deleted) {
      return res.status(404).json({
        success: false,
        error: `${month} 的月度报告不存在`
      });
    }

    res.json({
      success: true,
      message: `${month} 的月度报告已删除`
    });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
