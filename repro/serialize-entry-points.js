'use strict'
const path = require('node:path')
const Fastify = require('../fastify.js')

const contentSchema = (extra) => ({
  schema: {
    type: 'object',
    properties: { foo: { type: 'string' }, ...extra },
    additionalProperties: false
  }
})

const f = Fastify()
f.get('/t', {
  schema: {
    response: {
      200: { content: { 'application/json': contentSchema() } },
      400: { content: { 'application/json': contentSchema({ msg: { type: 'string' } }) } },
      default: { content: { 'application/json': contentSchema({ dft: { type: 'string' } }) } }
    }
  }
}, (req, reply) => {
  const out = {}
  const t = (n, fn) => {
    try { out[n] = { ok: fn() } } catch (e) { out[n] = { throw: e.constructor.name + ': ' + e.message } }
  }
  const input = { foo: 'bar', drop: 1 }
  t('A_reply.serialize_noCT', () => reply.serialize(input))
  t('B_reply.serialize_jsonCT', () => reply.type('application/json').serialize(input))
  t('C_reply.serialize_ctWithCharset', () => reply.type('application/json; charset=utf-8').serialize(input))
  t('D_serializeInput_200', () => reply.serializeInput(input, 200))
  t('E_serializeInput_200_json', () => reply.serializeInput(input, 200, 'application/json'))
  t('F_serializeInput_200_jsonCharset', () => reply.serializeInput(input, 200, 'application/json; charset=utf-8'))
  t('G_getSerializationFunction_200_json', () => typeof reply.getSerializationFunction(200, 'application/json'))
  t('H_getSerializationFunction_200_plain', () => typeof reply.getSerializationFunction(200))
  reply.type('text/plain').send(JSON.stringify(out, null, 1))
})

f.listen({ port: 0, host: '127.0.0.1' }).then(async () => {
  const port = f.server.address().port
  const res = await fetch(`http://127.0.0.1:${port}/t`)
  console.log('BODY>>>')
  console.log(await res.text())
  await f.close()
}).catch((e) => { console.error('LISTEN FAIL', e); process.exit(1) })
