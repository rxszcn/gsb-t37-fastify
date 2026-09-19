'use strict'
const path = require('node:path')
const Fastify = require('../fastify.js')

const s = () => ({ type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false })
const f = Fastify()
f.post('/t', {
  schema: {
    body: { content: { 'application/json': { schema: s() } } },
    headers: s()
  }
}, (req, reply) => {
  const out = {}
  const t = (n, fn) => { try { out[n] = { ok: fn() } } catch (e) { out[n] = { throw: e.constructor.name + ': ' + e.message } } }
  t('validateInput_body', () => req.validateInput({ a: 'x' }, 'body'))
  t('validateInput_headers', () => req.validateInput({ host: 'x' }, 'headers'))
  t('getValidationFunction_body', () => typeof req.getValidationFunction('body'))
  t('getValidationFunction_querystring', () => typeof req.getValidationFunction('querystring'))
  console.log(JSON.stringify(out, null, 1))
  reply.type('text/plain').send('see stdout')
})

f.listen({ port: 0, host: '127.0.0.1' }).then(async () => {
  const r = await fetch(`http://127.0.0.1:${f.server.address().port}/t`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":"x"}'
  })
  console.log('status', r.status, await r.text())
  await f.close()
}).catch((e) => { console.error('FAIL', e.message); process.exit(1) })
