// "Reports" — formatted PDFs of the collection. Everything is included while the site is free;
// the code for charging for a document stays in place but shows nothing unless billing is on.
import { $, $$, esc, money, fileSize, dateTimeLabel } from './format.js';
import { api, ApiError } from './api.js';
import { openModal, closeModal, toast } from './ui.js';

let data = null;
let hooks = {};

export async function renderReports(h) {
  hooks = h;
  $('#main').innerHTML = `<section><div class="page-head"><div>
    <h1>Reports</h1><p>Loading…</p></div></div></section>`;

  try {
    data = await api.get('/api/exports');
  } catch (err) {
    $('#main').innerHTML = `<div class="empty"><h3>Could not load reports</h3><p>${esc(err.message)}</p></div>`;
    return;
  }
  paint();
}

function paint() {
  const { documents, orders, pieceCount } = data;

  $('#main').innerHTML = `
    <section>
      <div class="page-head">
        <div>
          <h1>Reports</h1>
          <p>Formatted PDFs of your collection, for the people who ask for one.</p>
        </div>
      </div>

      <div class="doccards">
        ${documents.map(docCard).join('')}
      </div>

      <p class="doc-foot">
        Covers all ${pieceCount} piece${pieceCount === 1 ? '' : 's'} in your collection.
        ${data.documents.every(d => d.included) ? '' : 'Your own data is always free to export; what is priced here is the finished document.'}
      </p>

      <h2 class="doc-h2">Your reports</h2>
      ${orders.length ? ordersTable(orders) : `<div class="empty" style="padding:40px 24px">
        <h3>Nothing generated yet</h3>
        <p>Anything you make will be listed here to download again.</p>
      </div>`}
    </section>`;

  $$('#main [data-generate]').forEach(btn => {
    btn.onclick = () => generate(btn.dataset.generate);
  });
}

const docCard = (doc) => `
  <article class="doccard">
    <div class="doccard-top">
      <h3>${esc(doc.name)}</h3>
      ${doc.included ? '' : `<span class="price-tag">${esc(doc.price)}</span>`}
    </div>
    <p>${esc(doc.summary)}</p>
    <div class="doccard-foot">
      <span class="reason">${doc.included ? '' : esc(doc.reason)}</span>
      <button class="btn btn-primary btn-sm" data-generate="${esc(doc.kind)}">
        ${doc.included ? 'Generate' : `Generate for ${esc(doc.price)}`}
      </button>
    </div>
  </article>`;

const ordersTable = (orders) => `<div class="table-wrap"><table>
  <thead><tr>
    <th>Document</th><th class="hide-sm">Generated</th><th>Pieces</th>
    <th class="num">Total value</th>${orders.some(o => o.status !== 'included') ? '<th>Paid</th>' : ''}<th></th>
  </tr></thead>
  <tbody>${orders.map(o => `<tr style="cursor:default">
    <td class="tname">${esc(o.title)}</td>
    <td class="hide-sm">${dateTimeLabel(o.createdAt)}</td>
    <td>${o.pieceCount}</td>
    <td class="num">${o.totalValue == null ? '—' : money(o.totalValue)}</td>
    ${orders.some(x => x.status !== 'included') ? `<td>${o.status === 'included'
      ? '<span class="status active">Included</span>'
      : `<span class="status limit_reached">${esc(o.amount)}</span>`}</td>` : ''}
    <td>
      <div class="rowactions">
        <a class="btn btn-sm" href="${esc(o.url)}" target="_blank" rel="noopener">View</a>
        <a class="btn btn-sm" href="${esc(o.url)}?download=1">Download</a>
        <span style="color:var(--muted-2);font-size:12px;align-self:center">${fileSize(o.sizeBytes)}</span>
      </div>
    </td>
  </tr>`).join('')}</tbody></table></div>`;

async function generate(kind, confirmPurchase = false) {
  const doc = data.documents.find(d => d.kind === kind);
  const buttons = $$('#main [data-generate]');
  buttons.forEach(b => { b.disabled = true; });

  try {
    const res = await api.post('/api/exports', { kind, confirmPurchase });
    toast(`${res.order.title} ready.`);
    data = await api.get('/api/exports');
    paint();
    window.open(res.order.url, '_blank', 'noopener');
  } catch (err) {
    if (err instanceof ApiError && err.status === 402) {
      buttons.forEach(b => { b.disabled = false; });
      return offerPurchase(doc, err.body);
    }
    toast(err instanceof ApiError ? err.message : 'Could not generate that document.');
    buttons.forEach(b => { b.disabled = false; });
  }
}

/**
 * The purchase step. It collects nothing — no card, no billing details — because this build
 * takes no payment. It exists so the flow around a paid document can be tested end to end.
 */
function offerPurchase(doc, detail) {
  const modal = openModal(`
    <div class="modal-head"><h3>${esc(doc.name)}</h3><button class="x" data-close>×</button></div>
    <div class="modal-body">
      <p style="margin:0 0 16px;color:var(--muted)">${esc(doc.summary)}</p>
      <div class="urlbox" style="justify-content:space-between">
        <span>One-off, covering all ${data.pieceCount} pieces</span>
        <strong style="font-size:17px">${esc(detail.price)}</strong>
      </div>
      <div class="warn-note">
        <b>No payment is taken.</b> This build has no payment provider connected — confirming
        records the order and generates the document so the flow can be tested. In production this
        is where the checkout would open.
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn" type="button" data-close>Cancel</button>
      <button class="btn btn-primary" type="button" data-confirm>Confirm and generate</button>
    </div>`, { size: 'sm' });

  modal.querySelector('[data-confirm]').onclick = () => {
    closeModal();
    generate(doc.kind, true);
  };
}
