'use strict';
/**
 * Customer store wallet — balance on customers.wallet_inr, ledger in wallet_txns.
 *
 * Credit comes from order refunds (admin cancels a paid order) or admin manual
 * adjustments; debit comes from paying with wallet at checkout. Every change is
 * written to wallet_txns (signed amount_inr: +credit / −debit) so there's a full
 * audit trail. sql.js is synchronous + single-threaded, so the read-then-write in
 * debitWallet is effectively atomic (no await between the balance check and the
 * update — nothing else touches the DB in between).
 */
const { get, all, run } = require('./db');

function round2(n) { return Math.round((parseFloat(n) || 0) * 100) / 100; }

function getBalance(db, jid) {
  const r = get(db, `SELECT wallet_inr FROM customers WHERE jid=?`, [jid]);
  return r ? round2(r.wallet_inr) : 0;
}

// Add money to a wallet. amount > 0. Returns the new balance.
function creditWallet(db, jid, amount, { type = 'credit', label = '', ref_id = null } = {}) {
  const amt = round2(amount);
  if (!(amt > 0)) throw new Error('Credit amount must be positive');
  run(db, `UPDATE customers SET wallet_inr = COALESCE(wallet_inr,0) + ? WHERE jid=?`, [amt, jid]);
  run(db, `INSERT INTO wallet_txns (customer_jid, amount_inr, type, label, ref_id) VALUES (?,?,?,?,?)`,
    [jid, amt, type, label || '', ref_id != null ? String(ref_id) : null]);
  return getBalance(db, jid);
}

// Take money from a wallet. amount > 0. Throws { code:'INSUFFICIENT_FUNDS', balance }
// if the balance can't cover it. Returns the new balance.
function debitWallet(db, jid, amount, { type = 'debit', label = '', ref_id = null } = {}) {
  const amt = round2(amount);
  if (!(amt > 0)) throw new Error('Debit amount must be positive');
  const bal = getBalance(db, jid);
  if (bal + 0.001 < amt) { const e = new Error('INSUFFICIENT_FUNDS'); e.code = 'INSUFFICIENT_FUNDS'; e.balance = bal; throw e; }
  run(db, `UPDATE customers SET wallet_inr = COALESCE(wallet_inr,0) - ? WHERE jid=?`, [amt, jid]);
  run(db, `INSERT INTO wallet_txns (customer_jid, amount_inr, type, label, ref_id) VALUES (?,?,?,?,?)`,
    [jid, -amt, type, label || '', ref_id != null ? String(ref_id) : null]);
  return getBalance(db, jid);
}

// Admin manual adjustment — signed amount (positive credits, negative debits).
function adjustWallet(db, jid, signedAmount, label) {
  const amt = round2(signedAmount);
  if (amt === 0) throw new Error('Amount cannot be zero');
  return amt > 0
    ? creditWallet(db, jid, amt, { type: 'adjust', label: label || 'Admin credit' })
    : debitWallet(db, jid, -amt, { type: 'adjust', label: label || 'Admin debit' });
}

function getTxns(db, jid, limit = 50) {
  return all(db, `SELECT id, amount_inr, type, label, ref_id, created_at
                  FROM wallet_txns WHERE customer_jid=? ORDER BY id DESC LIMIT ?`, [jid, limit]);
}

module.exports = { getBalance, creditWallet, debitWallet, adjustWallet, getTxns };
