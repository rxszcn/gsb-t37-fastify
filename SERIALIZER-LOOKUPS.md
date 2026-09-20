# 序列化器查找：发送路径 vs 公开入口

## 一、三个 repro 脚本的逐条实测结果

### repro/serialize-entry-points.js

响应 schema 三个状态码（`200` / `400` / `default`）全部写成 `{ content: { 'application/json': { schema: ... } } }` 形式，输入 `{ foo: 'bar', drop: 1 }`：

- `A_reply.serialize_noCT`（`reply.serialize(input)`，未设 content-type）：抛 `TypeError: fnSerialize is not a function`
- `B_reply.serialize_jsonCT`（`reply.type('application/json').serialize(input)`）：抛 `TypeError: fnSerialize is not a function`
- `C_reply.serialize_ctWithCharset`（`reply.type('application/json; charset=utf-8').serialize(input)`）：抛 `TypeError: fnSerialize is not a function`
- `D_serializeInput_200`（`reply.serializeInput(input, 200)`）：抛 `TypeError: serialize is not a function`
- `E_serializeInput_200_json`（`reply.serializeInput(input, 200, 'application/json')`）：正常返回字符串 `{"foo":"bar"}`（`drop` 被 `additionalProperties: false` 裁掉）
- `F_serializeInput_200_jsonCharset`（`reply.serializeInput(input, 200, 'application/json; charset=utf-8')`）：抛 `FastifyError: Missing serialization function. Key "200:application/json; charset=utf-8"`
- `G_getSerializationFunction_200_json`（`typeof reply.getSerializationFunction(200, 'application/json')`）：返回 `"function"`
- `H_getSerializationFunction_200_plain`（`typeof reply.getSerializationFunction(200)`）：返回 `"object"`（拿回的是媒体类型映射对象，不是函数）

### repro/serialize-fallback.js

响应 schema 为 `'2xx': { content: { 'application/json': ... } }` 加 `default: { content: { '*/*': ... } }`，输入 `{ keep: 'k', drop: 'x' }`：

- `serializeInput_200`（`reply.serializeInput(input, 200)`）：抛 `FastifyError: Missing serialization function. Key "200"`（`200` 不会回退到 `2xx`）
- `serializeInput_2xx_json`（`reply.serializeInput(input, '2xx', 'application/json')`）：正常返回 `{"keep":"k"}`
- `serializeInput_default_anyCT`（`reply.serializeInput(input, 'default', 'application/json')`）：抛 `FastifyError: Missing serialization function. Key "default:application/json"`（`default` 下只有 `*/*`，不会用 `application/json` 命中，也不会从 `application/json` 回退到 `*/*`）
- `getSerFn_default_anyCT`（`String(reply.getSerializationFunction('default', 'application/json'))`）：返回 `"undefined"`
- `getSerFn_200`（`String(reply.getSerializationFunction(200))`）：返回 `"undefined"`
- 发送路径对照：同 handler 里 `reply.status(200).send(input)` 正常发出 `{"keep":"k"}`（`200` → `2xx` 回退生效）
- 发送路径对照：`/d` 路由只有 `default: { content: { '*/*': ... } }`，`reply.status(503).send({ keep: 'k', drop: 'x' })` 正常发出状态 `503`、body `{"keep":"k"}`、响应头 `content-type: application/json; charset=utf-8`（`503` → `5xx` → `default` → `*/*` 两级回退全部生效）

### repro/validate-entry-points.js

请求 schema 为 `body: { content: { 'application/json': { schema: ... } } }` 加普通 `headers` schema：

- `validateInput_body`（`req.validateInput({ a: 'x' }, 'body')`）：抛 `TypeError: validate is not a function`
- `validateInput_headers`（`req.validateInput({ host: 'x' }, 'headers')`）：正常返回 `true`
- `getValidationFunction_body`（`typeof req.getValidationFunction('body')`）：返回 `"object"`（content 映射对象，不是函数）
- `getValidationFunction_querystring`（`typeof req.getValidationFunction('querystring')`）：返回 `"undefined"`（路由未定义 querystring schema）
- 发送路径对照：正常 POST `/t`（`content-type: application/json`，body `{"a":"x"}`）返回状态 `200`，body 校验按 `request.mediaType` 正常命中

## 二、编译后的存储结构

路由注册时（`lib/validation.js`），响应 schema 编译结果挂在 `context[kSchemaResponse]` 上：

- 状态码的 schema 是普通 JSON Schema → 该状态码键下直接挂编译出的序列化**函数**：`responseSchemaDef['200'] = fn`
- 状态码的 schema 带 `content` 属性 → 该状态码键下挂的是**媒体类型映射对象**，键是 schema 里原样书写的媒体类型字符串：`responseSchemaDef['200'] = { 'application/json': fn }`（`lib/validation.js:31-44`）

请求侧同构：body schema 带 `content` 时，`context[bodySchema]` 是 `{ 'application/json': validateFn }` 映射对象而非函数（`lib/validation.js:256-265`）；headers/querystring/params 不带 `content`，直接挂函数。

## 三、发送路径怎么找（一切正常的那条路）

`reply.send()` 走 `lib/reply.js:546` → 内部 `serialize(context, payload, statusCode, contentType)`（`lib/reply.js:1081`，`contentType` 取自响应头）→ `getSchemaSerializer(context, statusCode, contentType)`（`lib/schemas.js:148`）。它的查找规则：

1. **状态码回退链**：先查精确状态码（如 `200`），落空查 `'{首位}xx'`（如 `2xx`），再落空查 `default`。
2. **命中后判断值类型**：若该键下的值是 plain object（即 content 映射），先用 `ContentType.from(contentType)` 把 content-type 头**解析归一化**（`lib/content-type.js`，按 RFC 9110 剥掉 `; charset=...` 等参数、小写化），取 `.mediaType` 作为键查映射；查不到再回退 `'*/*'` 键。
3. 该值不是对象时直接当函数返回。

请求侧对应物在 `lib/validation.js:354-361`：`context[bodySchema]` 不是函数时，用 `request.mediaType`（同样经 `ContentType` 解析）作键查映射。

关键转换就在第 2 步：**发送路径从不拿原始 content-type 字符串当键，拿的是解析后的 mediaType**，所以 `application/json; charset=utf-8` 能命中 `application/json` 键，且两级状态码回退和 `*/*` 兜底都在。

## 四、公开入口为什么落空

`reply.getSerializationFunction`（`lib/reply.js:357`）、`reply.serializeInput`（`lib/reply.js:413`）、`req.getValidationFunction`（`lib/request.js:296`）、`req.validateInput`（`lib/request.js:344`）全部是**直接用调用方给的原始值当下标**：

- `context[kSchemaResponse][status]` 或 `context[kSchemaResponse][status][contentType]`——`contentType` 是传入的原始字符串，**不做 `ContentType` 解析**，所以 `'application/json; charset=utf-8'` 这种带参数的串永远命中不了 `application/json` 键（结果 F）。
- **没有任何回退**：状态码不回退 `2xx`/`default`（`serializeInput_200` 报 `Key "200"`），媒体类型不回退 `*/*`（`serializeInput_default_anyCT` 报 `Key "default:application/json"`）。
- 只传状态码、不传 contentType 时，拿到的是整个 content 映射**对象**：`getSerializationFunction(200)` 返回对象（结果 H），`serializeInput(input, 200)` 因值非 null 不抛“缺函数”错、直接调用对象而崩 `TypeError: serialize is not a function`（结果 D）；请求侧 `validateInput(..., 'body')` 同理崩 `TypeError: validate is not a function`，`getValidationFunction('body')` 返回对象。
- `reply.serialize()`（`lib/reply.js:449`）调内部 `serialize(context, payload, statusCode)` 时**根本不传 contentType**（即使 `reply.type(...)` 设了头也不读）：`ContentType.from(undefined)` 的 `isValid` 为 false，`getSchemaSerializer` 跳过映射查找、把整个映射对象当函数返回，于是崩 `TypeError: fnSerialize is not a function`（结果 A/B/C，三者表现一致）。

一句话：发送路径的键是「回退后的状态码 + 归一化 mediaType（带 `*/*` 兜底）」，公开入口的键是「原样状态码 + 原样 content-type 字符串」，schema 一旦引入 `content` 层，后者查到的就是映射对象或 undefined。

## 五、应当统一的规则

所有公开入口（`reply.serialize` / `reply.serializeInput` / `reply.getSerializationFunction` 及请求侧 `req.validateInput` / `req.getValidationFunction`）应当与发送路径共用同一条查找规则：状态码按「精确码 → `{首位}xx` → `default`」回退，命中 content 映射时用 `ContentType` 解析后的 mediaType（剥离参数）作键并回退 `'*/*'`，且 `reply.serialize()` 应把当前响应 content-type 头纳入查找——即任何入口拿到的都只能是编译好的函数或“明确不存在”，永不暴露中间的媒体类型映射对象。
