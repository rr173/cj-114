const express = require('express');
const cors = require('cors');

const participantsRouter = require('./routes/participants');
const tradingDaysRouter = require('./routes/tradingDays');
const bidsRouter = require('./routes/bids');
const settlementRouter = require('./routes/settlement');
const contractsRouter = require('./routes/contracts');
const ancillaryServicesRouter = require('./routes/ancillaryServices');
const supervisionRouter = require('./routes/supervision');

const app = express();

app.use(cors());
app.use(express.json());

app.use('/api/participants', participantsRouter);
app.use('/api/trading-days', tradingDaysRouter);
app.use('/api/bids', bidsRouter);
app.use('/api/settlement', settlementRouter);
app.use('/api/contracts', contractsRouter);
app.use('/api/ancillary-services', ancillaryServicesRouter);
app.use('/api/supervision', supervisionRouter);

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: '电力现货市场出清与结算引擎运行中',
    timestamp: new Date().toISOString()
  });
});

app.use((req, res) => {
  res.status(404).json({ success: false, error: '接口不存在' });
});

app.use((err, req, res, next) => {
  console.error('[Server Error]', err);
  res.status(500).json({ success: false, error: '服务器内部错误' });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`电力现货市场出清与结算引擎已启动`);
  console.log(`服务地址: http://localhost:${PORT}`);
  console.log(`健康检查: http://localhost:${PORT}/api/health`);
});

module.exports = app;
