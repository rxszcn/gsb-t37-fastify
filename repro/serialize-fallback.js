'use strict'
const path = require('node:path')
const Fastify = require('../fastify.js')

const wrap = (props) => ({ schema: { type: 'object', properties: { keep: { type: 'string' }, ...props }, additionalProperties: false } })

const f = Fastify()
f.get('/t', {
  schema: {
    response: {
      '2xx': { content: { 'application/json': wrap() } },
      default: { content: { '*/*': wrap({ dft: { type: 'string' } }) } }
    }
  }
}, (req, reply) => {
  const out = {}
  const t = (n, fn) => {
    try { out[n] = { ok: fn() } } catch (e) { out[n] = { throw: e.constructor.name + ': ' + e.message } }
  }
  const input = { keep: 'k', drop: 'x' }
  t('serializeInput_200', () => reply.serializeInput(input, 200))
  t('serializeInput_2xx_json', () => reply.serializeInput(input, '2xx', 'application/json'))
  t('serializeInput_default_anyCT', () => reply.serializeInput(input, 'default', 'application/json'))
  t('getSerFn_default_anyCT', () => String(reply.getSerializationFunction('default', 'application/json')))
  t('getSerFn_200', () => String(reply.getSerializationFunction(200)))
  console.log(JSON.stringify(out, null, 1))
  reply.status(200).send(input)
})
f.get('/d', {
  schema: { response: { default: { content: { '*/*': wrap({ dft: { type: 'string' } }) } } } }
}, (req, reply) => reply.status(503).send({ keep: 'k', drop: 'x' }))

f.listen({ port: 0, host: '127.0.0.1' }).then(async () => {
  const base = `http://127.0.0.1:${f.server.address().port}`
  const r1 = await fetch(base + '/t'); console.log('send-2xx-body:', await r1.text())
  const r2 = await fetch(base + '/d'); console.log('send-default-/*/*:', r2.status, await r2.text(), '| ct=', r2.headers.get('content-type'))
  await f.close()
}).catch((e) => { console.error('FAIL', e.message); process.exit(1) })
