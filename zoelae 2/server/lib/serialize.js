'use strict';
// Every object that leaves the server is built here, field by field.
// Nothing is spread from a database row, so a new column can never leak by accident.

const money = (v) => (v === null || v === undefined ? null : Number(v));

function artworkForOwner(row, images = [], documents = []) {
  return {
    id: row.public_id,
    title: row.title,
    artist: row.artist,
    year: row.year_created,
    type: row.type,
    medium: row.medium || '',
    dimensions: row.dimensions || '',
    purchasePrice: money(row.purchase_price),
    currency: row.currency || 'EUR',
    currentValuation: money(row.current_valuation),
    insuredValue: money(row.insured_value),
    valuationDate: row.valuation_date || '',
    acquiredAt: row.acquired_at || '',
    acquiredFrom: row.acquired_from || '',
    provenance: row.provenance || '',
    priorOwners: row.prior_owners || '',
    exhibitionHistory: row.exhibition_history || '',
    storageLocation: row.storage_location || '',
    notes: row.notes || '',
    status: row.status || 'collection',
    inventoryNumber: row.inventory_number || '',
    askingPrice: money(row.asking_price),
    soldPrice: money(row.sold_price),
    soldAt: row.sold_at || '',
    soldTo: row.sold_to ? { id: row.sold_to.public_id, name: row.sold_to.name } : null,
    needsDetails: !!row.needs_details,
    createdAt: row.created_at,
    images: images.map(imageForOwner),
    documents: documents.map(documentForOwner)
  };
}

const imageForOwner = (img) => ({
  id: img.public_id,
  url: `/api/images/${img.public_id}`,                      // display size, for detail views
  thumbUrl: `/api/images/${img.public_id}?size=thumb`,       // 480 px, for the grid
  originalUrl: `/api/images/${img.public_id}?size=original`,
  width: img.width || null,
  height: img.height || null,
  mimeType: img.mime_type,
  sortOrder: img.sort_order
});

const documentForOwner = (doc) => ({
  id: doc.public_id,
  kind: doc.kind,
  label: doc.label,
  mimeType: doc.mime_type,
  sizeBytes: doc.byte_size,
  url: `/api/documents/${doc.public_id}`
});

/**
 * Viewer-facing projection. Fields the collector has not permitted are absent from the object —
 * not null, not empty string, not present at all — so they never reach the browser in any form.
 */
function artworkForViewer({ item, artwork, images, documents, share }) {
  const base = {
    id: item.public_id,                    // share-scoped id; the artwork's own id is never sent
    title: artwork.title,
    artist: artwork.artist,
    year: artwork.year_created,
    type: artwork.type,
    medium: artwork.medium || '',
    dimensions: artwork.dimensions || '',
    // Only "for sale" and "sold" mean anything to a viewer; "in the collection" says nothing.
    ...(artwork.status === 'for_sale' || artwork.status === 'sold' ? { availability: artwork.status } : {}),
    images: images.map((img, i) => ({
      id: img.public_id,
      url: `/api/s/${share.slug}/images/${img.public_id}`,
      thumbUrl: `/api/s/${share.slug}/images/${img.public_id}?size=thumb`,
      width: img.width || null,
      height: img.height || null,
      position: i + 1
    }))
  };

  if (share.show_prices) {
    if (artwork.status === 'for_sale' && artwork.asking_price != null) base.askingPrice = money(artwork.asking_price);
    base.prices = {
      currency: artwork.currency || 'EUR',
      purchasePrice: money(artwork.purchase_price),
      currentValuation: money(artwork.current_valuation),
      insuredValue: money(artwork.insured_value),
      valuationDate: artwork.valuation_date || ''
    };
  }
  if (share.show_provenance) {
    base.provenance = {
      acquiredAt: artwork.acquired_at || '',
      acquiredFrom: artwork.acquired_from || '',
      history: artwork.provenance || '',
      priorOwners: artwork.prior_owners || '',
      exhibitionHistory: artwork.exhibition_history || ''
    };
  }
  if (share.show_location) {
    base.location = { storageLocation: artwork.storage_location || '' };
  }
  if (share.show_documents) {
    base.documents = documents.map(doc => ({
      id: doc.public_id,
      kind: doc.kind,
      label: doc.label,
      mimeType: doc.mime_type,
      sizeBytes: doc.byte_size,
      url: `/api/s/${share.slug}/documents/${doc.public_id}`
    }));
  }
  return base;
}

/** Collector-facing view of a share. The passcode hash is never included. */
function shareForOwner(share, { itemCount = 0, status } = {}) {
  return {
    id: share.slug,                       // the slug is the collector's handle for it too
    slug: share.slug,
    title: share.title,
    introMessage: share.intro_message || '',
    itemCount,
    showPrices: !!share.show_prices,
    showDocuments: !!share.show_documents,
    showProvenance: !!share.show_provenance,
    showLocation: !!share.show_location,
    allowDownloads: !!share.allow_downloads,
    expiresAt: share.expires_at || null,
    maxViews: share.max_views === null || share.max_views === undefined ? null : Number(share.max_views),
    viewCount: share.view_count,
    revokedAt: share.revoked_at || null,
    status,
    createdAt: share.created_at,
    updatedAt: share.updated_at
  };
}

const userForClient = (row) => ({
  id: row.public_id,
  email: row.email,
  displayName: row.display_name || '',
  firstName: (row.display_name || '').trim().split(/\s+/)[0] || '',
  timezone: row.timezone || '',
  accountType: row.account_type || null,
  planTier: row.plan_tier || null,
  loginCount: row.login_count,
  lastLoginAt: row.last_login_at || null
});

function clientForOwner(row) {
  return {
    id: row.public_id,
    name: row.name,
    email: row.email || '',
    phone: row.phone || '',
    company: row.company || '',
    city: row.city || '',
    country: row.country || '',
    interests: row.interests || '',
    notes: row.notes || '',
    createdAt: row.created_at,
    messageCount: row.message_count ?? 0,
    lastContactedAt: row.last_contacted_at || null,
    worksBought: row.works_bought ?? 0
  };
}

module.exports = {
  clientForOwner, artworkForOwner, artworkForViewer, shareForOwner, userForClient, imageForOwner, documentForOwner };
