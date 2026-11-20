'use strict';
// What a plan includes, and what a one-off costs when it doesn't.
//
// The rule behind the pricing: a subscription is money for ongoing access, a document is money for
// a deadline. Normal and Pro include the documents outright — that is the reason to move up a tier.
// Everyone else can buy one when their insurer, solicitor or shipper actually asks for it, without
// being pushed into a subscription they didn't want.

const DOCUMENT_KINDS = {
  insurance_schedule: {
    key: 'insurance_schedule',
    name: 'Insurance schedule',
    summary: 'Every piece with its image, valuation, medium, dimensions and location, with totals — the document a broker asks for at renewal.',
    amountCents: 6000,
    sections: ['valuation', 'location']
  },
  estate_inventory: {
    key: 'estate_inventory',
    name: 'Estate inventory',
    summary: 'The same collection set out for probate, a settlement or a gift: valuations alongside provenance and prior owners, piece by piece.',
    amountCents: 9000,
    sections: ['valuation', 'provenance', 'location']
  }
};

const config = require('./../config');

const INCLUDED_TIERS = new Set(['normal', 'pro']);

/** @returns {{included:boolean, reason:string, amountCents:number, currency:string}} */
function entitlementFor(user, kind) {
  const doc = DOCUMENT_KINDS[kind];
  if (!doc) return null;

  if (config.freeBeta) {
    return { included: true, reason: `Included — ${config.siteName} is free to use.`, amountCents: 0, currency: 'EUR' };
  }
  const included = INCLUDED_TIERS.has(String(user.plan_tier || ''));
  return {
    included,
    reason: included
      ? `Included with your ${titleCase(user.account_type)} ${titleCase(user.plan_tier)} plan.`
      : 'Included on Normal and Pro. On your plan this is a one-off.',
    amountCents: included ? 0 : doc.amountCents,
    currency: 'EUR'
  };
}

const titleCase = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');

const formatMoney = (cents, currency = 'EUR') =>
  ({ EUR: '€', GBP: '£', USD: '$' }[currency] || '') + (cents / 100).toFixed(cents % 100 ? 2 : 0);

module.exports = { DOCUMENT_KINDS, INCLUDED_TIERS, entitlementFor, formatMoney, titleCase };
