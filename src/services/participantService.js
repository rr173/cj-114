const { v4: uuidv4 } = require('uuid');
const db = require('../utils/db');

const RENEWABLE_ENERGY_TYPES = ['wind', 'solar', 'hydro', 'biomass', 'geothermal'];
const ALL_ENERGY_TYPES = [...RENEWABLE_ENERGY_TYPES, 'thermal', 'nuclear', 'other'];
const INITIAL_CREDIT_SCORE = 70;

function registerParticipant(data) {
  const { code, name, type, installed_capacity, min_output, ramp_rate, contracted_capacity, energy_type } = data;

  if (!code || !name || !type) {
    throw new Error('编码、名称、类型为必填项');
  }

  if (!['generator', 'consumer'].includes(type)) {
    throw new Error('类型必须是 generator(发电侧) 或 consumer(用电侧)');
  }

  if (type === 'generator' && energy_type && !ALL_ENERGY_TYPES.includes(energy_type)) {
    throw new Error(`能源类型必须是: ${ALL_ENERGY_TYPES.join(', ')}`);
  }

  const existing = db.prepare('SELECT id FROM market_participants WHERE code = ?').get(code);
  if (existing) {
    throw new Error('主体编码已存在');
  }

  const id = uuidv4();
  const currentMonth = new Date().toISOString().slice(0, 7);

  const tx = db.transaction(() => {
    if (type === 'generator') {
      if (installed_capacity == null || min_output == null || ramp_rate == null) {
        throw new Error('发电侧需填写装机容量、最小出力、爬坡速率');
      }
      if (min_output >= installed_capacity) {
        throw new Error('最小出力必须小于装机容量');
      }
      const stmt = db.prepare(`
        INSERT INTO market_participants 
        (id, code, name, type, installed_capacity, min_output, ramp_rate, contracted_capacity, energy_type)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(id, code, name, type, installed_capacity, min_output, ramp_rate, null, energy_type || 'thermal');
    } else {
      if (contracted_capacity == null) {
        throw new Error('用电侧需填写签约用户总容量');
      }
      const stmt = db.prepare(`
        INSERT INTO market_participants 
        (id, code, name, type, installed_capacity, min_output, ramp_rate, contracted_capacity)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(id, code, name, type, null, null, null, contracted_capacity);
    }

    const initialLevel = INITIAL_CREDIT_SCORE >= 90 ? 'AAA' : 
                         INITIAL_CREDIT_SCORE >= 75 ? 'AA' : 
                         INITIAL_CREDIT_SCORE >= 60 ? 'A' : 'B';
    
    db.prepare(`
      INSERT INTO credit_scores 
      (id, participant_id, month, score, level, settlement_timeliness, settlement_timeliness_score,
       deviation_control, deviation_control_score, contract_performance, contract_performance_score,
       violation_count, violation_score, trading_restricted, manually_adjusted)
      VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
    `).run(uuidv4(), id, currentMonth, INITIAL_CREDIT_SCORE, initialLevel);

    db.prepare(`
      INSERT INTO credit_margin_accounts 
      (id, participant_id, balance, frozen_amount)
      VALUES (?, ?, 0, 0)
    `).run(uuidv4(), id);
  });

  tx();

  return getParticipantById(id);
}

function updateEnergyType(participantId, energyType) {
  const participant = getParticipantById(participantId);
  if (!participant) {
    throw new Error('市场主体不存在');
  }
  if (participant.type !== 'generator') {
    throw new Error('只有发电侧主体才能设置能源类型');
  }
  if (!ALL_ENERGY_TYPES.includes(energyType)) {
    throw new Error(`能源类型必须是: ${ALL_ENERGY_TYPES.join(', ')}`);
  }

  db.prepare('UPDATE market_participants SET energy_type = ? WHERE id = ?').run(energyType, participantId);
  return getParticipantById(participantId);
}

function isRenewableGenerator(participantId) {
  const p = getParticipantById(participantId);
  return p && p.type === 'generator' && RENEWABLE_ENERGY_TYPES.includes(p.energy_type);
}

function listRenewableGenerators() {
  return db.prepare(`
    SELECT * FROM market_participants 
    WHERE type = 'generator' AND energy_type IN (${RENEWABLE_ENERGY_TYPES.map(() => '?').join(', ')})
    ORDER BY created_at DESC
  `).all(...RENEWABLE_ENERGY_TYPES);
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
  listParticipants,
  updateEnergyType,
  isRenewableGenerator,
  listRenewableGenerators,
  RENEWABLE_ENERGY_TYPES
};
