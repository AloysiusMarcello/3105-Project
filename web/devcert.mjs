// Self-signed HTTPS certificate for testing on a phone over Wi-Fi, made with Node's own crypto
// (no openssl needed). Phones only allow the camera and motion sensors on https:// pages.
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';

const len = (n) => (n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff]);
const tlv = (tag, body) => Buffer.concat([Buffer.from([tag, ...len(body.length)]), body]);
const seq = (...items) => tlv(0x30, Buffer.concat(items));

function oid(dotted) {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const bytes = [40 * a + b];
  for (const n of rest) {
    const chunk = [n & 0x7f];
    for (let v = n >> 7; v > 0; v >>= 7) chunk.unshift((v & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

const utcTime = (d) => tlv(0x17, Buffer.from(`${d.toISOString().slice(2, 19).replace(/[-:T]/g, '')}Z`));
const name = (cn) => seq(tlv(0x31, seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(cn)))));

/** Returns { key, cert } PEM strings for a 1-year certificate covering `hosts` (names and IPv4 addresses). */
export function makeDevCert(hosts) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sha256WithRsa = seq(oid('1.2.840.113549.1.1.11'), Buffer.from([0x05, 0x00]));
  const serial = randomBytes(16);
  serial[0] &= 0x7f; // positive
  const now = new Date();
  const notBefore = new Date(now.getTime() - 24 * 3600e3);
  const notAfter = new Date(now.getTime() + 365 * 24 * 3600e3);

  const altNames = hosts.map((h) => (/^\d+\.\d+\.\d+\.\d+$/.test(h)
    ? tlv(0x87, Buffer.from(h.split('.').map(Number)))
    : tlv(0x82, Buffer.from(h))));
  const extensions = tlv(0xa3, seq(
    seq(oid('2.5.29.17'), tlv(0x04, seq(...altNames))), // subjectAltName
    seq(oid('2.5.29.37'), tlv(0x04, seq(oid('1.3.6.1.5.5.7.3.1')))), // extKeyUsage: serverAuth
  ));

  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))), // version 3
    tlv(0x02, serial),
    sha256WithRsa,
    name('E3 Navigator dev server'),
    seq(utcTime(notBefore), utcTime(notAfter)),
    name('E3 Navigator dev server'),
    publicKey.export({ type: 'spki', format: 'der' }),
    extensions,
  );
  const signature = sign('sha256', tbs, privateKey);
  const der = seq(tbs, sha256WithRsa, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const pem = der.toString('base64').match(/.{1,64}/g).join('\n');
  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    cert: `-----BEGIN CERTIFICATE-----\n${pem}\n-----END CERTIFICATE-----\n`,
  };
}
