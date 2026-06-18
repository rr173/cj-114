const { v4: uuidv4 } = require('uuid');
const db = require('../utils/db');
const { getParticipantById } = require('./participantService');

function createPriceZone(data) {
  const { code, name, description } = data;

  if (!code || !name) {
    throw new Error('电价区编码和名称为必填项');
  }

  const existing = db.prepare('SELECT id FROM price_zones WHERE code = ?').get(code);
  if (existing) {
    throw new Error('电价区编码已存在');
  }

  const id = uuidv4();
  const stmt = db.prepare(`
    INSERT INTO price_zones (id, code, name, description)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(id, code, name, description || null);

  return getPriceZoneById(id);
}

function getPriceZoneById(id) {
  const zone = db.prepare('SELECT * FROM price_zones WHERE id = ?').get(id);
  if (!zone) return null;

  const participants = db.prepare(`
    SELECT p.* FROM price_zone_participants zp
    JOIN market_participants p ON zp.participant_id = p.id
    WHERE zp.zone_id = ?
    ORDER BY p.type, p.code
  `).all(id);

  return { ...zone, participants };
}

function getPriceZoneByCode(code) {
  const zone = db.prepare('SELECT * FROM price_zones WHERE code = ?').get(code);
  if (!zone) return null;
  return getPriceZoneById(zone.id);
}

function listPriceZones() {
  const zones = db.prepare('SELECT * FROM price_zones ORDER BY created_at DESC').all();
  return zones.map(z => getPriceZoneById(z.id));
}

function assignParticipantToZone(zoneId, participantId) {
  const zone = getPriceZoneById(zoneId);
  if (!zone) {
    throw new Error('电价区不存在');
  }

  const participant = getParticipantById(participantId);
  if (!participant) {
    throw new Error('市场主体不存在');
  }

  const existing = db.prepare(`
    SELECT id FROM price_zone_participants 
    WHERE zone_id = ? AND participant_id = ?
  `).get(zoneId, participantId);

  if (existing) {
    throw new Error('该主体已在该区中');
  }

  db.prepare(`
    DELETE FROM price_zone_participants WHERE participant_id = ?
  `).run(participantId);

  const id = uuidv4();
  db.prepare(`
    INSERT INTO price_zone_participants (id, zone_id, participant_id)
    VALUES (?, ?, ?)
  `).run(id, zoneId, participantId);

  return getPriceZoneById(zoneId);
}

function removeParticipantFromZone(zoneId, participantId) {
  const zone = getPriceZoneById(zoneId);
  if (!zone) {
    throw new Error('电价区不存在');
  }

  const existing = db.prepare(`
    SELECT id FROM price_zone_participants 
    WHERE zone_id = ? AND participant_id = ?
  `).get(zoneId, participantId);

  if (!existing) {
    throw new Error('该主体不在该区中');
  }

  db.prepare(`
    DELETE FROM price_zone_participants 
    WHERE zone_id = ? AND participant_id = ?
  `).run(zoneId, participantId);

  return getPriceZoneById(zoneId);
}

function deletePriceZone(zoneId) {
  const zone = getPriceZoneById(zoneId);
  if (!zone) {
    throw new Error('电价区不存在');
  }

  db.prepare('DELETE FROM price_zones WHERE id = ?').run(zoneId);
  return true;
}

function getParticipantZone(participantId) {
  const row = db.prepare(`
    SELECT z.* FROM price_zone_participants zp
    JOIN price_zones z ON zp.zone_id = z.id
    WHERE zp.participant_id = ?
  `).get(participantId);
  return row || null;
}

function getZonesWithParticipants() {
  const zones = listPriceZones();
  return zones;
}

module.exports = {
  createPriceZone,
  getPriceZoneById,
  getPriceZoneByCode,
  listPriceZones,
  assignParticipantToZone,
  removeParticipantFromZone,
  deletePriceZone,
  getParticipantZone,
  getZonesWithParticipants
};
