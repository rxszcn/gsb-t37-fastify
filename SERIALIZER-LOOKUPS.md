# 序列化/校验公开入口在 `content` 嵌套 schema 下的现状记录

本文只记录现状，不改任何实现与测试。复现脚本：

- `repro/serialize-entry-points.js`
- `repro/serialize-fallback.js`
- `repro/validate-entry-points.js`

运行环境：Node.js v22.22.1，直接 `node repro/<脚本名>.js`。三个脚本进程均正常退出（退出码 `0`），stderr 无输出；下面逐字抄录 stdout（代码块内内容与脚本实际输出逐字一致，包括 `JSON.stringify(..., null, 1)` 的单空格缩进）。

## 1. `repro/serialize-entry-points.js` 逐行结果

stdout：

```
BODY>>>
{
 "A_reply.serialize_noCT": {
  "throw": "TypeError: fnSerialize is not a function"
 },
 "B_reply.serialize_jsonCT": {
  "throw": "TypeError: fnSerialize is not a function"
 },
 "C_reply.serialize_ctWithCharset": {
  "throw": "TypeError: fnSerialize is not a function"
 },
 "D_serializeInput_200": {
  "throw": "TypeError: serialize is not a function"
 },
 "E_serializeInput_200_json": {
  "ok": "{\"foo\":\"bar\"}"
 },
 "F_serializeInput_200_jsonCharset": {
  "throw": "FastifyError: Missing serialization function. Key \"200:application/json; charset=utf-8\""
 },
 "G_getSerializationFunction_200_json": {
  "ok": "function"
 },
 "H_getSerializationFunction_200_plain": {
  "ok": "object"
 }
}
```

逐条：

| 探针 | 结果 | 拿到/抛错的东西 |
| --- | --- | --- |
| A `reply.serialize(input)`（未设 content-type） | 崩 | `TypeError: fnSerialize is not a function` |
| B `reply.type('application/json').serialize(input)` | 崩 | `TypeError: fnSerialize is not a function` |
| C `reply.type('application/json; charset=utf-8').serialize(input)` | 崩 | `TypeError: fnSerialize is not a function` |
| D `reply.serializeInput(input, 200)` | 崩 | `TypeError: serialize is not a function` |
| E `reply.serializeInput(input, 200, 'application/json')` | 返回 | 字符串 `"{\"foo\":\"bar\"}"`（`drop: 1` 被裁掉） |
| F `reply.serializeInput(input, 200, 'application/json; charset=utf-8')` | 崩 | `FastifyError: Missing serialization function. Key "200:application/json; charset=utf-8"` |
| G `reply.getSerializationFunction(200, 'application/json')` | 返回 | `function`（可调用的序列化函数） |
| H `reply.getSerializationFunction(200)` | 返回 | `object`（不是函数，是 `{ 'application/json': fn }` 这层媒体类型映射） |

## 2. `repro/serialize-fallback.js` 逐行结果

stdout：

```
{
 "serializeInput_200": {
  "throw": "FastifyError: Missing serialization function. Key \"200\""
 },
 "serializeInput_2xx_json": {
  "ok": "{\"keep\":\"k\"}"
 },
 "serializeInput_default_anyCT": {
  "throw": "FastifyError: Missing serialization function. Key \"default:application/json\""
 },
 "getSerFn_default_anyCT": {
  "ok": "undefined"
 },
 "getSerFn_200": {
  "ok": "undefined"
 }
}
send-2xx-body: {"keep":"k"}
send-default-/*/*: 503 {"keep":"k"} | ct= application/json; charset=utf-8
```

逐条：

| 探针 / 请求 | 结果 | 拿到/抛错的东西 |
| --- | --- | --- |
| `serializeInput(input, 200)`（schema 里只有 `2xx`/`default`） | 崩 | `FastifyError: Missing serialization function. Key "200"` |
| `serializeInput(input, '2xx', 'application/json')` | 返回 | 字符串 `"{\"keep\":\"k\"}"`（`drop: 'x'` 被裁掉） |
| `serializeInput(input, 'default', 'application/json')`（default 下只有 `*/*`） | 崩 | `FastifyError: Missing serialization function. Key "default:application/json"` |
| `getSerializationFunction('default', 'application/json')` | 返回 | `undefined`（空） |
| `getSerializationFunction(200)`（只有 `2xx`/`default`） | 返回 | `undefined`（空） |
| 正常 `GET /t` → `reply.status(200).send(input)` | 正常 | 响应体 `{"keep":"k"}`，走 `2xx` + `application/json` 回退并裁剪 |
| 正常 `GET /d` → 503（default + `*/*`） | 正常 | 状态 `503`，响应体 `{"keep":"k"}`（`dft`/`drop` 被裁），`content-type: application/json; charset=utf-8` |

## 3. `repro/validate-entry-points.js` 逐行结果

stdout：

```
{
 "validateInput_body": {
  "throw": "TypeError: validate is not a function"
 },
 "validateInput_headers": {
  "ok": true
 },
 "getValidationFunction_body": {
  "ok": "object"
 },
 "getValidationFunction_querystring": {
  "ok": "undefined"
 }
}
status 200 see stdout
```

逐条：

| 探针 | 结果 | 拿到/抛错的东西 |
| --- | --- | --- |
| `req.validateInput({ a: 'x' }, 'body')`（body 为 `content` 嵌套） | 崩 | `TypeError: validate is not a function` |
| `req.validateInput({ host: 'x' }, 'headers')`（普通 headers schema，对照组） | 返回 | 布尔 `true` |
| `req.getValidationFunction('body')` | 返回 | `object`（不是函数，是 `{ 'application/json': fn }` 媒体类型映射） |
| `req.getValidationFunction('querystring')`（该路由无 querystring schema） | 返回 | `undefined`（空） |

## 4. 两条查找路径各自按什么键找

### 4.1 编译产物的形状

`lib/validation.js` 的 `compileSchemasForSerialization` 按 `schema.response` 逐个状态码编译（状态码键统一 `toLowerCase()`，并校验形如 `200`/`2xx`/`default`），挂到路由 context 的 `kSchemaResponse` 上：

- 扁平写法（`response: { 200: schema }`）：`kSchemaResponse['200'] = fn`，值就是函数。
- `content` 嵌套写法：`kSchemaResponse['200'] = { 'application/json': fn, ... }`，状态码下面再套一层以媒体类型为键的映射。

请求侧同构：`compileSchemasForValidation` 对 `schema.body.content` 编译出 `context[kSchemaBody] = { 'application/json': fn, ... }`；普通 body schema 则直接是函数。headers/params/querystring 不支持 `content` 嵌套，始终编译成函数。

### 4.2 正常发送路径（`reply.send`，全部正确）

对象载荷在 `Reply.prototype.send`（`lib/reply.js`）里若未显式设置 content-type，会被默认写成 `application/json; charset=utf-8`；随后 `preSerializationHookEnd` 调用内部函数：

```
serialize(context, payload, reply.raw.statusCode, reply[kReplyHeaders]['content-type'])
```

`serialize`（`lib/reply.js` 末尾）再调 `getSchemaSerializer(context, statusCode, contentType)`（`lib/schemas.js`）。它做两层事：

1. 状态码三级回退：精确码（数字 `200` 经 JS 属性访问自动等价于字符串键 `'200'`）→ 首位数字加 `xx`（`2xx`/`5xx`）→ `default`。
2. 每一级上，若值是普通对象（即 `content` 嵌套产生的媒体类型映射），用 `ContentType.from(contentType)` 解析，**取 `.mediaType`**：小写化并剥掉 `; charset=utf-8` 等参数，先按精确媒体类型命中，再退到 `*/*`；解析不出合法 content-type 时才直接返回该级原值。

所以 `send-2xx-body`（精确码没有、`2xx` 有、媒体类型经解析命中）与 503 + `default` + `*/*`（两级状态回退 + 媒体类型兜底）都正确命中函数，裁剪、状态类型回退、`default`/`*/*` 兜底全部生效。

### 4.3 公开入口（`lib/reply.js` / `lib/request.js`，全部按裸键直取）

三个公开入口都不经过 `getSchemaSerializer`，而是直接对 context 上的编译产物做裸属性访问：

- `reply.getSerializationFunction(status, contentType)`：`kSchemaResponse?.[status]?.[contentType]`；不传 contentType 时返回 `kSchemaResponse?.[status]`。不解析 content-type、不剥参数、不做 `Nxx`/`default` 回退、不认 `*/*`。因此 G 精确命中拿到 `function`，H 拿到的是整层映射 `object`，`getSerFn_default_anyCT`/`getSerFn_200` 只返回 `undefined`（空），不报错。
- `reply.serializeInput(input, schema, httpStatus, contentType)`：同样的裸键直取；取不到值时按是否带 contentType 分别抛 `FST_ERR_MISSING_SERIALIZATION_FN`（`Missing serialization function. Key "200"`）或 `FST_ERR_MISSING_CONTENTTYPE_SERIALIZATION_FN`（`Missing serialization function. Key "200:application/json; charset=utf-8"`）。两种落空都源于不做发送路径那套转换：
  - D `serializeInput(input, 200)`：键存在但值是映射对象，空值检查放行，末尾 `serialize(input)` 直接调用那个对象 → `TypeError: serialize is not a function`（崩）。
  - F 带 `; charset=utf-8`：映射里只有剥过参数的 `application/json` 键，裸键查不到 → 误报“没有这个状态码的序列化函数”。
  - `serializeInput_200`（只有 `2xx`）与 `default` + `application/json`（只有 `*/*`）同理：状态回退与通配媒体类型兜底都不存在，直接报缺失。
  - E 是唯一恰好与裸键完全一致的调用（`200` + 精确 `application/json`），所以返回正确裁剪后的字符串。
- `reply.serialize(payload)`（A/B/C，无条件序列化）：它调用内部 `serialize(context, payload, this.raw.statusCode)` 时**根本不传 content-type**——即使之前 `reply.type(...)` 设置过也被丢掉。`getSchemaSerializer` 在 content-type 不合法且该状态码的值是媒体类型映射时，返回映射对象本身（真值），`serialize` 随即 `fnSerialize(data)` 调用该对象 → 三种写法一律 `TypeError: fnSerialize is not a function`（崩）。
- 请求侧 `req.validateInput(input, 'body')` / `req.getValidationFunction('body')`：直接取 `context[kSchemaBody]`。`content` 嵌套时该值是 `{ 'application/json': fn }` 映射：`getValidationFunction` 返回 `object`；`validateInput` 拿到映射不判形状直接 `validate(input)` → `TypeError: validate is not a function`（崩）。正常请求校验路径（`lib/validation.js` 的 `validate`）则先判断 `typeof context[bodySchema] === 'function'`，否则用 `request.mediaType`（同样由 `ContentType.from(...)` 解析、剥掉 charset 参数）去索引这层映射——与响应发送路径同构地正确。该 API 签名里也没有 contentType 参数，调用方无法手动指定媒体类型。

对照之下，扁平 schema 下编译产物的值本身就是函数，裸键直取恰好拿到函数，所以这些入口只有在“状态码/body 下面再套一层媒体类型”时才坏。

## 5. 从现状推出的其他边界

- 状态码键在编译时被 `toLowerCase()`：公开入口传数字 `200` 靠 JS 属性强转能命中 `'200'`，但传 `'2XX'` 这种大写泛化键命中不了；泛化码与 `default` 的回退只有发送路径有。
- content-type 参数（`charset` 等）只有发送路径会剥离；公开入口把整串当键，`application/json; charset=utf-8` 与 `application/json` 被当成两个键，且失败时报的是“整个状态码没有序列化函数”，语义上是误报。
- `*/*` 通配兜底只在发送路径生效；公开入口查 `default` + `application/json` 时即使存在 `*/*` 也只得到 `undefined`/缺失错误。
- `getSerializationFunction` 查不到一律返回 `undefined`（与文档承诺一致），形状错误（映射当函数）只在调用方自己去调用时才暴露；`serializeInput`/`serialize`/`validateInput` 则在调用映射对象时以 `TypeError` 崩，缺失时抛 `FastifyError`，两类失败形态不同。
- 以 schema 对象（而非状态码）调用 `getSerializationFunction`/`serializeInput` 走的是 `WeakMap` 缓存/即时编译分支，不经这层映射，不受此问题影响。
- 请求侧只有 `body` 能写 `content` 嵌套，故请求半边只有 body 受影响；headers 等普通部分编译出来就是函数（`validateInput_headers` 返回 `true`），无 querystring schema 时 `getValidationFunction('querystring')` 返回 `undefined`。

## 6. 应当统一的规则

公开入口与发送路径必须共用同一个解析过程：先按“精确状态码 → `Nxx` → `default`（请求侧 body 无状态层，直接按 part）”定位，再用 `ContentType` 解析 content-type、剥除参数得到小写 media type，按“精确媒体类型 → `*/*`”解析出唯一的函数——getter 只返回函数或 `undefined`，`serialize`/`serializeInput`/`validateInput` 一律拿到函数后再调用、取不到统一报缺失，且 `reply.serialize` 必须把 reply 当前的 content-type 透传进去，`validateInput` 需允许显式传入或自动采用请求的 media type。
