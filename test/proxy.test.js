'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
function run(code, env = {}) {
  return spawnSync(process.execPath, ['-e', code], { cwd: root, env: { ...process.env, PUBLIC_URL: '', TRUST_PROXY: '1', TRUSTED_PROXIES: '10.12.254.12,2001:db8::/64', PROXY_ONLY: '1', ...env }, encoding: 'utf8', timeout: 5000 });
}
test('only configured proxy peers may supply forwarding headers or access proxy-only mode', () => {
  const r = run(`
    const S=require('./lib/security');const A=require('node:assert/strict');
    const req=ip=>({method:'GET',socket:{remoteAddress:ip},headers:{'x-forwarded-for':'192.0.2.9, 198.51.100.7','x-forwarded-proto':'https'}});
    const trusted=req('::ffff:10.12.254.12'),forged=req('10.12.254.13');
    A.equal(S.clientIp(trusted),'198.51.100.7');A.equal(S.isHttps(trusted),true);A.equal(S.allowRequest(trusted,'/api/me'),true);
    A.equal(S.clientIp(forged),'10.12.254.13');A.equal(S.isHttps(forged),false);A.equal(S.allowRequest(forged,'/api/health'),false);
    A.equal(S.trustProxy(req('2001:db8::1')),true);A.equal(S.trustProxy(req('2001:db9::1')),false);
    const local=req('127.0.0.1');A.equal(S.allowRequest(local,'/api/health'),true);A.equal(S.allowRequest(local,'/api/account'),false);
    local.method='POST';A.equal(S.allowRequest(local,'/api/health'),false);
    trusted.headers['x-forwarded-for']='not-an-ip';A.equal(S.clientIp(trusted),'10.12.254.12');
    trusted.headers['x-forwarded-proto']='https,http';A.equal(S.isHttps(trusted),false);
  `);
  assert.equal(r.status, 0, r.stderr);
});
test('unsafe proxy-only configuration is rejected at startup; trust without an allowlist ignores headers', () => {
  for (const env of [{ TRUSTED_PROXIES: '' }, { TRUST_PROXY: '0' }, { TRUSTED_PROXIES: '10.1.1.1/99' }, { TRUSTED_PROXIES: 'all' }]) {
    assert.notEqual(run("require('./lib/security')", env).status, 0);
  }
  const r = run("const S=require('./lib/security');require('node:assert/strict').equal(S.clientIp({socket:{remoteAddress:'10.1.1.1'},headers:{'x-forwarded-for':'192.0.2.1'}}),'10.1.1.1')", { TRUSTED_PROXIES: '', PROXY_ONLY: '0' });
  assert.equal(r.status, 0, r.stderr);
});
test('security logs exclude raw network, identity and free-text details', () => {
  const r = run("require('./lib/security').log('test',{socket:{remoteAddress:'10.1.2.3'},headers:{}},{account:'123456789',name:'PRIVATE NAME',ip:'1.2.3.4',ref:'PRIVATE REF',reason:'test'})");
  assert.equal(r.status, 0, r.stderr);
  const log = JSON.parse(r.stdout);
  assert.match(log.source, /^[a-f0-9]{24}$/); assert.match(log.actor, /^[a-f0-9]{24}$/); assert.equal(log.reason, 'test');
  for (const secret of ['10.1.2.3', '1.2.3.4', '123456789', 'PRIVATE']) assert.ok(!r.stdout.includes(secret));
});
test('canonical HTTPS cannot be downgraded through forwarded protocol headers', () => {
  const r = run(`
    const S=require('./lib/security'),A=require('node:assert/strict');
    const req={socket:{remoteAddress:'10.12.254.12'},headers:{'x-forwarded-proto':'http'}};
    A.equal(S.isHttps(req),true);A.match(S.cookie(req,'session','value',{maxAge:1}),/; Secure$/);
    const headers={};S.securityHeaders(req,{setHeader:(k,v)=>headers[k]=v});A.equal(headers['Strict-Transport-Security'],'max-age=31536000');
    req.socket.remoteAddress='10.12.254.13';A.equal(S.isHttps(req),false);
  `, { PUBLIC_URL: 'https://lan.example.org' });
  assert.equal(r.status, 0, r.stderr);
});
