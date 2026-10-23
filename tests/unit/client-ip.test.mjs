// Gerçek istemci IP'si: tünel/vekil (loopback) arkasında başlıklardan, doğrudan bağlantıda soketten.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientIp } from '../../server/limits.js';

const req = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers });

test('loopback (cloudflared/nginx aynı makinede): CF-Connecting-IP, yoksa X-Forwarded-For son öğesi', () => {
  assert.equal(clientIp(req('::1', { 'cf-connecting-ip': '188.119.56.138', 'x-forwarded-for': '6.6.6.6, 188.119.56.138' })), '188.119.56.138');
  assert.equal(clientIp(req('127.0.0.1', { 'x-forwarded-for': '6.6.6.6, 10.0.0.5' })), '10.0.0.5');
  assert.equal(clientIp(req('::1')), '0:0:0:0::/64'); // loopback da /64 anahtarına iner
});

test('doğrudan bağlantı: başlıklar yok sayılır (sahte IP ile sınır atlatılamaz)', () => {
  assert.equal(clientIp(req('192.168.1.50', { 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-for': '1.2.3.4' })), '192.168.1.50');
});

test('IPv6 adresleri /64 ağına indirgenir; IPv4-mapped IPv4 olur (sınırlar tek tek adreslerle atlatılamasın)', async () => {
  const { ipKey } = await import('../../server/limits.js');
  assert.equal(ipKey('2001:db8:1:1::1'), ipKey('2001:db8:1:1::ffff'));
  assert.notEqual(ipKey('2001:db8:1:1::1'), ipKey('2001:db8:1:2::1'));
  assert.equal(ipKey('::ffff:1.2.3.4'), '1.2.3.4');
  assert.equal(clientIp(req('::1', { 'cf-connecting-ip': '2001:db8:1:1::7' })), '2001:db8:1:1::/64');
});
