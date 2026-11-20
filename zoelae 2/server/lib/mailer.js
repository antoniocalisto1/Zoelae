'use strict';
// Outgoing email. With POSTMARK_SERVER_TOKEN set, messages go out through Postmark. Without it,
// each message is written to the outbox folder instead, and on a development machine the outbox
// can be read at /dev/outbox, so every flow that sends email can be tried end to end locally.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./../config');

const configured = () => Boolean(config.postmarkToken);

async function viaPostmark({ to, subject, text, html, tag, from, replyTo, attachments }) {
  const res = await fetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Postmark-Server-Token': config.postmarkToken
    },
    body: JSON.stringify({
      From: from || config.mailFrom, To: to, Subject: subject,
      TextBody: text, HtmlBody: html, Tag: tag, MessageStream: 'outbound',
      ...(replyTo ? { ReplyTo: replyTo } : {}),
      ...(attachments?.length ? { Attachments: attachments.map(a => ({ Name: a.name, Content: a.content.toString('base64'), ContentType: a.type })) } : {})
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Postmark refused the message (${res.status}): ${body.slice(0, 200)}`);
  }
}

function toOutbox({ attachments, ...message }) {
  fs.mkdirSync(config.outboxDir, { recursive: true });
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
  // Attachments sit beside the message so they can be opened from /dev/outbox.
  const files = (attachments || []).map((a, i) => {
    const file = `${id}-${i}${path.extname(a.name) || ''}`;
    fs.writeFileSync(path.join(config.outboxDir, file), a.content);
    return { name: a.name, type: a.type, file, size: a.content.length };
  });
  fs.writeFileSync(path.join(config.outboxDir, `${id}.json`),
    JSON.stringify({ id, from: message.from || config.mailFrom, createdAt: new Date().toISOString(), ...message, attachments: files }, null, 2));
  return id;
}

/**
 * Never throws: a failed email must not turn into a failed request that leaks whether an
 * account exists. Failures are logged for the operator instead.
 */
async function send(message) {
  try {
    if (configured()) { await viaPostmark(message); return { sent: true }; }
    toOutbox(message);
    return { sent: false, outbox: true };
  } catch (err) {
    console.error(`Email to ${message.to} failed: ${err.message}`);
    return { sent: false, error: true };
  }
}

function listOutbox() {
  if (!fs.existsSync(config.outboxDir)) return [];
  return fs.readdirSync(config.outboxDir).filter(f => f.endsWith('.json')).sort().reverse().slice(0, 200)
    .map(f => JSON.parse(fs.readFileSync(path.join(config.outboxDir, f), 'utf8')));
}

function outboxFile(file) {
  if (!/^[\w-]+\.[a-z0-9]{2,5}$/i.test(file)) return null;
  const full = path.join(config.outboxDir, file);
  return fs.existsSync(full) ? full : null;
}

function readOutbox(id) {
  if (!/^[\w-]+$/.test(id)) return null;
  const file = path.join(config.outboxDir, `${id}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

module.exports = { send, configured, listOutbox, readOutbox, outboxFile };
