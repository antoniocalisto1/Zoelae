'use strict';
// Figures behind the welcome page.
const express = require('express');
const { db } = require('./../db');
const { requireCollector } = require('./../middleware/collectorAuth');
const { computeStatus, STATUS } = require('./../lib/shareState');

const router = express.Router();
router.use(requireCollector);

const totals = db.prepare(`SELECT
    COUNT(*)                                        AS total_pieces,
    SUM(CASE WHEN current_valuation IS NOT NULL THEN 1 ELSE 0 END) AS valued_pieces,
    COALESCE(SUM(current_valuation), 0)             AS total_valuation,
    SUM(CASE WHEN status = 'for_sale' THEN 1 ELSE 0 END) AS for_sale,
    SUM(CASE WHEN status = 'sold' THEN 1 ELSE 0 END)     AS sold
  FROM artworks WHERE owner_id = ?`);

const sharesForOwner = db.prepare('SELECT * FROM shared_collections WHERE owner_id = ?');

router.get('/', (req, res) => {
  const t = totals.get(req.user.id);

  // "This month" is resolved in the collector's own timezone, so a piece added late on the 1st
  // does not fall into last month for someone east of UTC.
  const tz = req.user.timezone || 'UTC';
  let monthStart;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit' })
      .format(new Date()).split('-');
    monthStart = `${parts[0]}-${parts[1]}-01T00:00:00.000Z`;
  } catch {
    monthStart = new Date().toISOString().slice(0, 8) + '01T00:00:00.000Z';
  }
  const addedThisMonth = db.prepare('SELECT COUNT(*) AS c FROM artworks WHERE owner_id = ? AND created_at >= ?')
    .get(req.user.id, monthStart).c;

  const shares = sharesForOwner.all(req.user.id);
  const activeShares = shares.filter(s => computeStatus(s) === STATUS.ACTIVE).length;

  res.json({
    summary: {
      totalPieces: t.total_pieces,
      valuedPieces: t.valued_pieces,
      // Only meaningful when at least one valuation exists — the UI hides the tile when null.
      totalValuation: t.valued_pieces > 0 ? t.total_valuation : null,
      addedThisMonth,
      forSale: t.for_sale || 0,
      sold: t.sold || 0,
      activeSharedLinks: activeShares,
      totalSharedLinks: shares.length
    }
  });
});

module.exports = router;
