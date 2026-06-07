#!/usr/bin/env node
/**
 * One-time import: reads "ST Strategy" (May) and "ST Strategy - June 2026" (June)
 * from Daily_PL_Tracker.xlsx and writes daily-trades-YYYY-MM-DD.json files.
 *
 * Usage:
 *   node scripts/import-excel-history.js
 *
 * Requires: pip install openpyxl  (uses Python subprocess)
 * Close Excel before running, or it auto-copies to C:\Temp\pl_temp.xlsx first.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.join(__dirname, '..');
const LOGS_DIR  = path.join(ROOT, 'logs');
const XLSX_SRC  = 'C:\\Users\\ksrin\\OneDrive\\Trading\\Daily_PL_Tracker.xlsx';
const XLSX_TEMP = 'C:\\Temp\\pl_temp.xlsx';

// Copy to temp first (avoids "file locked" when Excel is open)
try {
  execSync(`powershell -Command "Copy-Item '${XLSX_SRC}' '${XLSX_TEMP}' -Force"`, { stdio: 'pipe' });
  console.log('Copied to temp file.');
} catch (e) {
  console.warn('Could not copy — will try original path directly.');
}

const xlsxPath = fs.existsSync(XLSX_TEMP) ? XLSX_TEMP : XLSX_SRC;

// Python script that reads both sheets and prints JSON
const pyScript = `
import openpyxl, json, sys
from datetime import datetime, time as ttime

SHEETS = ['ST Strategy', 'ST Strategy - June 2026']
LOT_SIZES = {'NIFTY': 65, 'SENSEX': 20}

wb = openpyxl.load_workbook(r'${xlsxPath.replace(/\\/g, '\\\\')}', data_only=True)
all_days = {}
trade_id = 1

for sheet_name in SHEETS:
    if sheet_name not in wb.sheetnames:
        print(f'[WARN] Sheet not found: {sheet_name}', file=sys.stderr)
        continue
    ws = wb[sheet_name]
    for row in ws.iter_rows(min_row=3, values_only=True):
        if len(row) < 14:
            continue
        date_val, instr, entry_time, lots, qty, entry_price, exit_sl, exit_nsl, charges, pnl_sl, pnl_nsl, tgt_pts, exit_tgt, pnl_tgt = row[:14]
        notes = row[14] if len(row) > 14 else None

        # Must have a real time (not a formula result or number), valid price, and sane lots
        if not isinstance(date_val, datetime):
            continue
        if not isinstance(entry_time, ttime):
            continue
        if entry_price is None or not (0 < float(entry_price) < 5000):
            continue
        if lots is None or not (1 <= int(lots) <= 100):
            continue

        date_str = date_val.strftime('%Y-%m-%d')
        instr_upper = str(instr or '').strip().upper()
        if instr_upper not in ('NIFTY', 'SENSEX'):
            instr_upper = 'NIFTY'

        entry_time_str = entry_time.strftime('%H:%M') if isinstance(entry_time, ttime) else str(entry_time or '')

        trade = {
            'id': trade_id,
            'instrument': instr_upper,
            'side': '',
            'entrySymbol': '',
            'entryTime': entry_time_str,
            'exitTime': '',
            'lots': int(lots) if lots else 10,
            'lotSize': LOT_SIZES.get(instr_upper, 65),
            'entryPrice': round(float(entry_price), 2) if entry_price is not None else None,
            'exitPrice':  round(float(exit_nsl), 2)    if exit_nsl  is not None else None,
            'exitSL':     round(float(exit_sl), 2)     if exit_sl   is not None else None,
            'exitNSL':    round(float(exit_nsl), 2)    if exit_nsl  is not None else None,
            'tgtPts':     round(float(tgt_pts), 2)     if tgt_pts   is not None else None,
            'charges':    round(float(charges), 2)     if charges   is not None else 0,
            'notes':      str(notes).strip() if notes else '',
        }
        trade_id += 1

        if date_str not in all_days:
            all_days[date_str] = {'date': date_str, 'instrument': instr_upper, 'trades': []}
        all_days[date_str]['trades'].append(trade)

print(json.dumps(all_days))
`;

let result;
try {
  result = execSync(`python -c "${pyScript.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, {
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 10 * 1024 * 1024,
  });
} catch (e) {
  // Try with multiline via temp py file
  const tmpPy = path.join(ROOT, 'logs', '_import_tmp.py');
  fs.writeFileSync(tmpPy, pyScript);
  try {
    result = execSync(`python "${tmpPy}"`, { stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 10 * 1024 * 1024 });
    fs.unlinkSync(tmpPy);
  } catch (e2) {
    fs.unlinkSync(tmpPy);
    console.error('Python error:', e2.stderr?.toString() || e2.message);
    process.exit(1);
  }
}

const allDays = JSON.parse(result.toString().trim());
const dates   = Object.keys(allDays).sort();

if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

let saved = 0, skipped = 0;
for (const date of dates) {
  const outPath = path.join(LOGS_DIR, `daily-trades-${date}.json`);
  if (fs.existsSync(outPath)) {
    console.log(`  SKIP  ${date}  (file already exists — delete to re-import)`);
    skipped++;
    continue;
  }
  fs.writeFileSync(outPath, JSON.stringify(allDays[date], null, 2));
  console.log(`  SAVED ${date}  ${allDays[date].trades.length} trades`);
  saved++;
}

console.log(`\nDone. ${saved} files saved, ${skipped} skipped.`);
console.log(`Open http://localhost:3000/supertrend-reports to view.`);
