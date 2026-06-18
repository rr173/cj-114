const { v4: uuidv4 } = require('uuid');
const db = require('../utils/db');
const { getPriceZoneById } = require('./priceZoneService');

function createTieLine(data) {
  const { code, name, from_zone_id, to_zone_id, max_transfer_capacity, description } = data;

  if (!code || !name || !from_zone_id || !to_zone_id || max_transfer_capacity == null) {
    throw new Error('编码、名称、起点区、终点区、最大传输容量为必填项');
  }

  if (max_transfer_capacity <= 0) {
    throw new Error('最大传输容量必须大于0');
  }

  if (from_zone_id === to_zone_id) {
    throw new Error('起点区和终点区不能相同');
  }

  const fromZone = getPriceZoneById(from_zone_id);
  if (!fromZone) {
    throw new Error('起点电价区不存在');
  }

  const toZone = getPriceZoneById(to_zone_id);
  if (!toZone) {
    throw new Error('终点电价区不存在');
  }

  const existing = db.prepare('SELECT id FROM tie_lines WHERE code = ?').get(code);
  if (existing) {
    throw new Error('联络线编码已存在');
  }

  const id = uuidv4();
  const stmt = db.prepare(`
    INSERT INTO tie_lines (id, code, name, from_zone_id, to_zone_id, max_transfer_capacity, description)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(id, code, name, from_zone_id, to_zone_id, max_transfer_capacity, description || null);

  return getTieLineById(id);
}

function getTieLineById(id) {
  const line = db.prepare('SELECT * FROM tie_lines WHERE id = ?').get(id);
  if (!line) return null;

  const fromZone = db.prepare('SELECT id, code, name FROM price_zones WHERE id = ?').get(line.from_zone_id);
  const toZone = db.prepare('SELECT id, code, name FROM price_zones WHERE id = ?').get(line.to_zone_id);

  return {
    ...line,
    from_zone: fromZone,
    to_zone: toZone
  };
}

function getTieLineByCode(code) {
  const line = db.prepare('SELECT id FROM tie_lines WHERE code = ?').get(code);
  if (!line) return null;
  return getTieLineById(line.id);
}

function listTieLines() {
  const lines = db.prepare('SELECT id FROM tie_lines ORDER BY created_at DESC').all();
  return lines.map(l => getTieLineById(l.id));
}

function updateMaxTransferCapacity(tieLineId, maxCapacity) {
  const line = getTieLineById(tieLineId);
  if (!line) {
    throw new Error('联络线不存在');
  }

  if (maxCapacity == null || maxCapacity <= 0) {
    throw new Error('最大传输容量必须大于0');
  }

  db.prepare(`
    UPDATE tie_lines SET max_transfer_capacity = ? WHERE id = ?
  `).run(maxCapacity, tieLineId);

  return getTieLineById(tieLineId);
}

function deleteTieLine(tieLineId) {
  const line = getTieLineById(tieLineId);
  if (!line) {
    throw new Error('联络线不存在');
  }

  db.prepare('DELETE FROM tie_lines WHERE id = ?').run(tieLineId);
  return true;
}

function getTieLinesBetweenZones(zoneAId, zoneBId) {
  const lines = db.prepare(`
    SELECT id FROM tie_lines 
    WHERE (from_zone_id = ? AND to_zone_id = ?) 
       OR (from_zone_id = ? AND to_zone_id = ?)
  `).all(zoneAId, zoneBId, zoneBId, zoneAId);

  return lines.map(l => getTieLineById(l.id));
}

module.exports = {
  createTieLine,
  getTieLineById,
  getTieLineByCode,
  listTieLines,
  updateMaxTransferCapacity,
  deleteTieLine,
  getTieLinesBetweenZones
};
