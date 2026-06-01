#!/usr/bin/env node
/**
 * Diagnose: check what shape APIs are available in TradingView Desktop.
 * Run AFTER the monitor has drawn some lines (zone + day levels visible on chart).
 * Usage: node scripts/diagnose-shapes.js
 */
import { CDPManager } from '../src/cdp.js';
import fs from 'fs';

const cdp = new CDPManager();
await cdp.connect();

// Read current drawn IDs
let drawnIds = { levelIds: [], zoneIds: [], importantIds: [] };
try {
  drawnIds = JSON.parse(fs.readFileSync('./logs/drawn-ids.json', 'utf8'));
} catch (_) {
  /* ignore */
}

console.log('Drawn IDs:', JSON.stringify(drawnIds, null, 2));

const allIds = [
  ...drawnIds.zoneIds.map((id) => ({ id, type: 'zone' })),
  ...drawnIds.importantIds.map((id) => ({ id, type: 'important' })),
  ...drawnIds.levelIds.slice(0, 2).map((id) => ({ id, type: 'level' })),
];

console.log(
  '\nTesting shape APIs for IDs:',
  allIds.map((x) => x.id)
);

const script = `
(async function() {
  const chart = window.TradingViewApi?.activeChart?.();
  if (!chart) return { error: 'No chart' };

  const ids = ${JSON.stringify(allIds.map((x) => x.id))};
  const results = {};

  // 1. getAllShapes
  const allShapes = typeof chart.getAllShapes === 'function' ? chart.getAllShapes() : 'N/A';
  results.getAllShapes = Array.isArray(allShapes) ? allShapes.slice(0, 5) : allShapes;

  // 2. Per-ID checks
  results.perId = {};
  for (const id of ids) {
    const info = {};
    try {
      // getShapeById
      const shape = chart.getShapeById?.(id);
      info.getShapeById = shape ? 'exists' : 'null';
      if (shape) {
        info.shapeKeys = Object.getOwnPropertyNames(shape).slice(0, 15);
        info.shapeProtoKeys = Object.getOwnPropertyNames(Object.getPrototypeOf(shape) || {}).slice(0, 15);
        // try getPoints
        const pts = shape.getPoints?.() ?? shape.points?.();
        info.getPoints = pts ? JSON.stringify(pts) : 'N/A';
        // try getProperties / properties
        const props = shape.getProperties?.() ?? shape.properties?.();
        info.getProperties = props ? JSON.stringify(props).slice(0, 200) : 'N/A';
      }
    } catch(e) { info.error = e.message; }
    results.perId[id] = info;
  }

  return results;
})()
`;

const result = await cdp.executeScript(script);
console.log('\nResult:');
console.log(JSON.stringify(result, null, 2));

await cdp.disconnect?.();
process.exit(0);
