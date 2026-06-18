const { v4: uuidv4 } = require('uuid');
const db = require('../utils/db');

function registerParticipant(data) {
  const { code, name, type, installed_capacity, min_output, ramp_rate, contracted_capacity } = data;

  if (!code || !name || !type) {
    throw new Error('编码、名称、类型为必填项');
  }

  if (!['generator', 'consumer'].includes(type)) {
    throw new Error('类型必须是 generator(发电侧) 或 consumer(用电侧)');
  }

  const existing = db.prepare('SELECT id FROM market_participants WHERE code = ?').get(code);
  if (existing) {
    throw new Error('主体编码已存在');
  }

  const id = uuidv4();
  const stmt = db.prepare(`
    INSERT INTO market_participants 
    (id, code, name, type, installed_capacity, min_output, ramp_rate, contracted_capacity)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  if (type === 'generator') {
    if (installed_capacity == null || min_output == null || ramp_rate == null) {
      throw new Error('发电侧需填写装机容量、最小出力、爬坡速率');
    }
    if (min_output >= installed_capacity) {
      throw new Error('最小出力必须小于装机容量');
    }
    stmt.run(id, code, name, type, installed_capacity, min_output, ramp_rate, null);
  } else {
    if (contracted_capacity == null) {
      throw new Error('用电侧需填写签约用户总容量');
    }
    stmt.run(id, code, name, type, null, null, null, contracted_capacity);
  }

  return getParticipantById(id);
}

function getParticipantById(id) {
  return db.prepare('SELECT * FROM market_participants WHERE id = ?').get(id);
}

function getParticipantByCode(code) {
  return db.prepare('SELECT * FROM market_participants WHERE code = ?').get(code);
}

function listParticipants(type = null) {
  let sql = 'SELECT * FROM market_participants';
  const params = [];
  if (type) {
    sql += ' WHERE type = ?';
    params.push(type);
  }
  sql += ' ORDER BY created_at DESC';
  return db.prepare(sql).all(...params);
}

module.exports = {
  registerParticipant,
  getParticipantById,
  getParticipantByCode,
  listParticipants
};
