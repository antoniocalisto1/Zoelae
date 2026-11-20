'use strict';
// The emails Zoelae sends, in the Atelier look: warm white ground, a white card with a hairline,
// a light serif heading (Georgia in mail clients), square ink button. No web fonts are loaded, so
// opening an email tells no font service anything. Every message has a plain-text twin.
const config = require('./../config');

const esc = (s) => String(s == null ? '' : s)
  .replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

function layout({ preheader, heading, paragraphs, button, footnote }) {
  const p = paragraphs.map(t => `<p style="margin:0 0 16px;font:16px/1.6 -apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#5f5a52">${t}</p>`).join('');
  const b = button ? `
    <table role="presentation" cellspacing="0" cellpadding="0" style="margin:8px 0 24px"><tr>
      <td style="background:#141311">
        <a href="${esc(button.href)}" style="display:inline-block;padding:15px 26px;font:500 13px -apple-system,'Segoe UI',Helvetica,Arial,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:#faf9f7;text-decoration:none">${esc(button.label)}</a>
      </td></tr></table>
    <p style="margin:0 0 16px;font:13px/1.6 -apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#8a847b">If the button doesn't work, paste this into your browser:<br><span style="color:#141311;word-break:break-all">${esc(button.href)}</span></p>` : '';
  const f = footnote ? `<p style="margin:24px 0 0;padding-top:16px;border-top:1px solid #e6e2dc;font:13px/1.6 -apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#8a847b">${footnote}</p>` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
</head>
<body style="margin:0;background:#faf9f7">
<span style="display:none;max-height:0;overflow:hidden">${esc(preheader)}</span>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#faf9f7"><tr><td align="center" style="padding:32px 16px">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px">
    <tr><td style="padding:0 4px 22px;font:400 17px Georgia,'Times New Roman',serif;letter-spacing:.34em;text-transform:uppercase;color:#141311">${esc(config.siteName)}</td></tr>
    <tr><td style="background:#ffffff;border:1px solid #e6e2dc;padding:36px 34px">
      <h1 style="margin:0 0 20px;font:400 28px/1.15 Georgia,'Times New Roman',serif;color:#141311">${esc(heading)}</h1>
      ${p}${b}${f}
    </td></tr>
    <tr><td style="padding:18px 4px 0;font:12px/1.6 -apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#a39d93">${esc(config.siteName)} · a private catalogue for art · ${esc(config.sitePlace)}</td></tr>
  </table>
</td></tr></table></body></html>`;
}

function passwordReset({ name, link, minutes }) {
  const hello = name ? `Hello ${esc(name.split(' ')[0])},` : 'Hello,';
  return {
    subject: `Reset your ${config.siteName} password`,
    tag: 'password-reset',
    text: `${name ? `Hello ${name.split(' ')[0]},` : 'Hello,'}\n\nSomeone asked to reset the password for this ${config.siteName} account. If it was you, open this link to choose a new one. It works once, for the next ${minutes} minutes:\n\n${link}\n\nIf you didn't ask for this, ignore this email. Your password stays as it is.\n\n${config.siteName}`,
    html: layout({
      preheader: `This link works once, for the next ${minutes} minutes.`,
      heading: 'Choose a new password',
      paragraphs: [hello, `Someone asked to reset the password for this ${config.siteName} account. If it was you, use the button below. The link works once, for the next ${minutes} minutes.`],
      button: { href: link, label: 'Choose a new password' },
      footnote: 'If you didn’t ask for this, ignore this email. Your password stays as it is and nobody can use this link without access to your inbox.'
    })
  };
}

function passwordChanged({ name, when }) {
  const hello = name ? `Hello ${esc(name.split(' ')[0])},` : 'Hello,';
  return {
    subject: `Your ${config.siteName} password was changed`,
    tag: 'password-changed',
    text: `${name ? `Hello ${name.split(' ')[0]},` : 'Hello,'}\n\nThe password for your ${config.siteName} account was changed on ${when}. Every other device has been signed out.\n\nIf this wasn't you, reset your password straight away at ${config.origin()}/app?mode=forgot\n\n${config.siteName}`,
    html: layout({
      preheader: 'Every other device has been signed out.',
      heading: 'Your password was changed',
      paragraphs: [hello, `The password for your ${config.siteName} account was changed on ${esc(when)}. Every other device has been signed out.`],
      footnote: `If this wasn’t you, <a href="${esc(config.origin())}/app?mode=forgot" style="color:#141311">reset your password</a> straight away.`
    })
  };
}

/** A gallery (or artist) writing to one of its clients: their words, a link or a PDF. */
function toClient({ fromName, fromEmail, clientName, subject, message, link, passcode, pdfName }) {
  const paragraphs = String(message || '').split(/\n{2,}/).map(p => esc(p.trim()).replace(/\n/g, '<br>')).filter(Boolean);
  const notes = [];
  if (link && passcode) notes.push(`Passcode: <b style="font-family:ui-monospace,Menlo,monospace;letter-spacing:.08em;color:#141311">${esc(passcode)}</b>`);
  else if (link) notes.push(`You’ll need the passcode from ${esc(fromName)} to open it.`);
  if (pdfName) notes.push(`The works are in the attached PDF, <b>${esc(pdfName)}</b>.`);
  const footnote = `${notes.join('<br>')}${notes.length ? '<br><br>' : ''}Sent by ${esc(fromName)} through ${esc(config.siteName)}. Reply to this email to reach ${esc(fromName)} directly${fromEmail ? ` at ${esc(fromEmail)}` : ''}.`;
  const textNotes = [
    link ? `View the collection: ${link}` : null,
    link && passcode ? `Passcode: ${passcode}` : link ? `You'll need the passcode from ${fromName} to open it.` : null,
    pdfName ? `The works are in the attached PDF, ${pdfName}.` : null
  ].filter(Boolean).join('\n');
  return {
    subject,
    tag: link ? 'client-link' : 'client-pdf',
    text: `${message}\n\n${textNotes}\n\n—\nSent by ${fromName} through ${config.siteName}. Reply to this email to reach ${fromName} directly.`,
    html: layout({
      preheader: String(message || '').slice(0, 120),
      heading: subject,
      paragraphs,
      button: link ? { href: link, label: 'View the collection' } : null,
      footnote
    }).replace(`>${esc(config.siteName)}</td>`, `>${esc(fromName)}</td>`)
  };
}

module.exports = { passwordReset, passwordChanged, toClient };
