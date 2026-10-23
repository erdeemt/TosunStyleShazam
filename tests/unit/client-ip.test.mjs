// Gerçek istemci IP'si: tünel/vekil (loopback) arkasında başlıklardan, doğrudan bağlantıda soketten.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientIp } from '../../server/limits.js';

const req = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers });

test('loopback (cloudflared/nginx aynı makinede): CF-Connecting-IP, yoksa X-Forwarded-For son öğesi', () => {
  assert.equal(clientIp(req('::1', { 'cf-connecting-ip': '188.119.56.138', 'x-forwarded-for': '6.6.6.6, 188.119.56.138' })), '188.119.56.138');
  assert.equal(clientIp(req('127.0.0.1', { 'x-forwarded-for': '6.6.6.6, 10.0.0.5' })), '10.0.0.5');
  assert.equal(clientIp(req('::1')), '::1');
});

test('doğrudan bağlantı: başlıklar yok sayılır (sahte IP ile sınır atlatılamaz)', () => {
  assert.equal(clientIp(req('192.168.1.50', { 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-for': '1.2.3.4' })), '192.168.1.50');
});
