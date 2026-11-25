import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveApiBase, toWs } from './e2e-api.mjs';

test('bloqueia o hostname de produção inclusive caixa e ponto DNS final', () => {
  const previous = process.env.PALCO_E2E_API_URL;
  try {
    for (const base of ['https://api.pianolouvorja.com.br', 'https://API.PIANOLOUVORJA.COM.BR.', 'https://api.pianolouvorja.com.br.:443/v1']) {
      process.env.PALCO_E2E_API_URL = base;
      assert.throws(() => resolveApiBase(), /PRODUÇÃO/);
    }
    for (const base of ['http://localhost:3100', 'https://api-stg.pianolouvorja.com.br']) {
      process.env.PALCO_E2E_API_URL = base;
      assert.equal(resolveApiBase(), base);
    }
    delete process.env.PALCO_E2E_API_URL;
    assert.equal(resolveApiBase(), 'http://localhost:3100');
    assert.equal(toWs('https://localhost:3100'), 'wss://localhost:3100');
  } finally {
    if (previous === undefined) delete process.env.PALCO_E2E_API_URL;
    else process.env.PALCO_E2E_API_URL = previous;
  }
});
